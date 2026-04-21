/**
 * 模块: 企微智能贴士 + 火苗宠物
 *
 * 架构: Reply Transformer 模式
 * 时机: 传输层发送消息前，追加贴士和宠物
 * 优势: 在所有 agent/plugin hook 处理完毕后操作，避免与 enhance 等插件冲突
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { setReplyTransformer } from "../runtime.js";
import {
  type TipsCustomConfig,
  buildEffectivePool,
  matchTipForScene,
  matchProbabilityCommand,
  selectRandomTip,
  formatTipBlock,
} from "./tips-data.js";

// ── 配置 ──

export interface WecomTipsConfig {
  enabled?: boolean;
  probability?: number;
  forceShow?: boolean;
  sceneAware?: boolean;
  showPet?: boolean;
  custom?: TipsCustomConfig;
}

export interface WecomPetConfig {
  enabled?: boolean;
  name?: string;
  color?: "orange" | "blue" | "purple" | "green" | "white";
}

// ── 宠物类型 ──

type FlameColor = "orange" | "blue" | "purple" | "green" | "white";
type FlameMood = "idle" | "busy" | "error" | "success" | "sleep";

interface FlamePet {
  agent_id: string;
  name: string;
  color: FlameColor;
  level: number;
  xp: number;
  total_xp: number;
  mood: FlameMood;
  created_at: string;
  updated_at: string;
}

const MOOD_EMOJI: Record<FlameMood, string> = {
  idle: "🔥",
  busy: "💨",
  error: "😵",
  success: "✨",
  sleep: "💤",
};

const COLOR_EMOJI: Record<FlameColor, string> = {
  orange: "🧡",
  blue: "💙",
  purple: "💜",
  green: "💚",
  white: "🤍",
};

// ── 宠物存储 ──

function getPetDir(): string {
  const homeDir =
    process.env.OPENCLAW_HOME || join(process.env.HOME || "~", ".openclaw");
  const petDir = join(homeDir, "data", "wecom-pets");
  if (!existsSync(petDir)) {
    mkdirSync(petDir, { recursive: true });
  }
  return petDir;
}

function loadPet(agentId: string, petConfig?: WecomPetConfig): FlamePet {
  const petPath = join(getPetDir(), `${agentId}.json`);
  if (existsSync(petPath)) {
    try {
      return JSON.parse(readFileSync(petPath, "utf-8"));
    } catch {
      // 读取失败，返回默认宠物
    }
  }
  return {
    agent_id: agentId,
    name: petConfig?.name ?? "小火苗",
    color: petConfig?.color ?? "orange",
    level: 1,
    xp: 0,
    total_xp: 0,
    mood: "idle",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

function savePet(pet: FlamePet): void {
  const petPath = join(getPetDir(), `${pet.agent_id}.json`);
  pet.updated_at = new Date().toISOString();
  writeFileSync(petPath, JSON.stringify(pet, null, 2), "utf-8");
}

function xpForLevel(level: number): number {
  return level * 100 + (level - 1) * 50;
}

function addXp(pet: FlamePet, amount: number): void {
  pet.xp += amount;
  pet.total_xp += amount;
  while (pet.xp >= xpForLevel(pet.level)) {
    pet.xp -= xpForLevel(pet.level);
    pet.level++;
  }
}

function formatPet(pet: FlamePet): string {
  return `\n---\n> **${COLOR_EMOJI[pet.color]} ${pet.name}** Lv.${pet.level}\n> ${MOOD_EMOJI[pet.mood]} 活泼好动\n> 经验: ${pet.xp}/${xpForLevel(pet.level)}\n`;
}

// ── 注册模块 ──

export function registerWecomTipsPet(
  api: OpenClawPluginApi,
  tipsConfig?: WecomTipsConfig,
  petConfig?: WecomPetConfig,
) {
  const tipsEnabled = tipsConfig?.enabled !== false;
  const petEnabled = petConfig?.enabled !== false;
  const probability = tipsConfig?.probability ?? 0.3;
  const forceShow = tipsConfig?.forceShow ?? false;
  const sceneAware = tipsConfig?.sceneAware ?? true;
  const showPet = tipsConfig?.showPet ?? true;

  if (!tipsEnabled && !petEnabled) return;

  // 构建有效贴士池（默认 + 自定义，模仿 Claude Code spinnerTipsOverride）
  const effectivePool = buildEffectivePool(tipsConfig?.custom);

  // 动态概率：每个对话可独立调节，默认使用配置值
  const dynamicProbability = new Map<string, number>();

  // 待发送的概率控制反馈消息（由 message_received 写入，transformer 消费）
  const pendingProbabilityReply = new Map<string, string>();

  // 捕获用户消息用于场景匹配 + 语言控制概率
  const lastUserMessages = new Map<string, string>();

  api.on("message_received", (event, ctx) => {
    if (ctx.channelId !== "wecom") return;
    const key = ctx.conversationId ?? ctx.accountId ?? "default";
    lastUserMessages.set(key, event.content);

    // 检测概率控制指令
    if (tipsEnabled) {
      const cmd = matchProbabilityCommand(event.content);
      if (cmd) {
        dynamicProbability.set(key, cmd.value);
        pendingProbabilityReply.set(key, cmd.reply);
        api.logger.info(
          `[wecom-tips] 概率调整: ${cmd.name} (${cmd.value}) for ${key}`,
        );
      }
    }
  });

  // 注册传输层 Reply Transformer
  setReplyTransformer((text, ctx) => {
    const trimmed = text.trim().toUpperCase();

    // 跳过空输出、NO_REPLY、HEARTBEAT_OK
    if (!text || trimmed === "" || trimmed === "NO_REPLY" || trimmed === "HEARTBEAT_OK") {
      return text;
    }

    let result = text;
    const convKey = ctx.peerId;

    // 如果有待发送的概率控制反馈，追加到回复
    const probReply = pendingProbabilityReply.get(convKey);
    if (probReply) {
      pendingProbabilityReply.delete(convKey);
      result += `\n\n${probReply}`;
    }

    // 处理贴士（使用动态概率，不存在则用配置默认值）
    const currentProb = dynamicProbability.get(convKey) ?? probability;
    if (tipsEnabled && (forceShow || Math.random() <= currentProb)) {
      const userMsg = lastUserMessages.get(ctx.peerId) ?? "";
      const tip =
        sceneAware && userMsg
          ? matchTipForScene(userMsg, effectivePool)
          : selectRandomTip(effectivePool);
      result += formatTipBlock(tip);
    }

    // 处理宠物
    if (petEnabled && showPet) {
      const pet = loadPet(ctx.accountId, petConfig);
      if (pet.mood !== "sleep") {
        pet.mood = "idle";
      }
      addXp(pet, 2);
      savePet(pet);
      result += formatPet(pet);
    }

    return result;
  });

  // ── 注册宠物工具 ──

  if (petEnabled) {
    api.registerTool((_toolContext: any) => ({
      name: "wecom_pet_status",
      label: "火苗宠物状态",
      description: "查看火苗宠物状态",
      parameters: { type: "object", properties: {}, required: [] },
      async execute(_toolCallId: string, _params: any, ctx: any) {
        const id = (ctx?.agentId ?? "main").trim();
        const pet = loadPet(id, petConfig);
        return {
          content: [
            {
              type: "text",
              text: `🔥 ${pet.name} 状态\n等级: ${pet.level}\n心情: ${pet.mood} ${MOOD_EMOJI[pet.mood]}\n颜色: ${pet.color} ${COLOR_EMOJI[pet.color]}\n经验: ${pet.xp}/${xpForLevel(pet.level)}`,
            },
          ],
        };
      },
    }) as any);

    api.registerTool((_toolContext: any) => ({
      name: "wecom_pet_interact",
      label: "火苗宠物互动",
      description: "与火苗宠物互动（喂食、抚摸、休息、玩耍、训练）",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["feed", "pet", "rest", "play", "train"],
          },
        },
        required: ["action"],
      },
      async execute(_toolCallId: string, params: any, ctx: any) {
        const id = (ctx?.agentId ?? "main").trim();
        const pet = loadPet(id, petConfig);
        const action = params.action as string;

        const xpMap: Record<string, number> = {
          feed: 15,
          pet: 5,
          rest: 3,
          play: 10,
          train: 20,
        };
        const moodMap: Record<string, FlameMood> = {
          feed: "success",
          pet: "idle",
          rest: "sleep",
          play: "busy",
          train: "busy",
        };

        pet.mood = moodMap[action] || "idle";
        addXp(pet, xpMap[action] || 5);
        savePet(pet);

        return {
          content: [
            {
              type: "text",
              text: `${formatPet(pet)}\n互动「${action}」成功！+${xpMap[action] || 5} XP`,
            },
          ],
        };
      },
    }) as any);
  }

  const features = [
    tipsEnabled ? "智能贴士" : null,
    petEnabled ? "火苗宠物" : null,
  ]
    .filter(Boolean)
    .join(" + ");
  api.logger.info(`[wecom] ${features}模块已加载（replyTransformer 模式）`);
}
