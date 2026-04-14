/**
 * 模块: 企微火苗宠物
 *
 * Hook: after_agent_reply
 * 时机: AI 回复发送后，追加宠物
 * 注意：小贴士功能已禁用，待修复
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// ── 配置 ──
export interface WecomTipsConfig {
  enabled?: boolean;
  probability?: number;
  forceShow?: boolean;
  sceneAware?: boolean;
  showPet?: boolean;
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
  const homeDir = process.env.OPENCLAW_HOME || join(process.env.HOME || "~", ".openclaw");
  const petDir = join(homeDir, "data", "wecom-pets");
  if (!existsSync(petDir)) {
    mkdirSync(petDir, { recursive: true });
  }
  return petDir;
}

function loadPet(agentId: string): FlamePet {
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
    name: "小火苗",
    color: "orange",
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

// ── 格式化宠物 ──
function formatPet(pet: FlamePet): string {
  return `\n---\n> **${COLOR_EMOJI[pet.color]} ${pet.name}** Lv.${pet.level}\n> ${MOOD_EMOJI[pet.mood]} 活泼好动\n> 经验: ${pet.xp}/${xpForLevel(pet.level)}\n`;
}

// ── 注册模块 ──
export function registerWecomTipsPet(
  api: OpenClawPluginApi,
  tipsConfig?: WecomTipsConfig,
  petConfig?: WecomPetConfig
) {
  const petEnabled = petConfig?.enabled !== false;
  const showPet = petConfig?.enabled !== false;

  // 小贴士功能已禁用 - 需要修复后再启用
  const tipsEnabled = false;

  if (!tipsEnabled && !petEnabled) return;

  // ── Hook: after_agent_reply ──
  api.on("after_agent_reply" as any, (event: any, ctx: any): any => {
    const agentId = (ctx?.agentId ?? "main").trim();
    
    // 获取回复内容
    const replyText = event?.reply?.text ?? "";
    
    // 跳过空输出、NO_REPLY、HEARTBEAT_OK
    const trimmed = replyText.trim().toUpperCase();
    if (!replyText || trimmed === "" || trimmed === "NO_REPLY" || trimmed === "HEARTBEAT_OK") {
      return {};
    }

    let newText = replyText;

    // 处理宠物（只追加宠物，不处理贴士）
    if (petEnabled && showPet) {
      const pet = loadPet(agentId);
      if (event?.reply?.isError) {
        pet.mood = "error";
      } else if (pet.mood !== "sleep") {
        pet.mood = "idle";
      }
      addXp(pet, 2);
      savePet(pet);
      newText += formatPet(pet);
    }

    if (newText === replyText) {
      return {};
    }

    api.logger.info(`[wecom-pet] 追加宠物到回复 (agent: ${agentId})`);

    // 返回修改后的内容
    return {
      handled: true,
      reply: {
        text: newText,
        isError: event?.reply?.isError ?? false,
      },
    };
  });

  // 注册宠物工具
  if (petEnabled) {
    api.registerTool((toolContext: any) => ({
      name: "wecom_pet_status",
      label: "火苗宠物状态",
      description: "查看火苗宠物状态",
      parameters: { type: "object", properties: {}, required: [] },
      async execute(_toolCallId: string, _params: any, ctx: any) {
        const id = (ctx?.agentId ?? "main").trim();
        const pet = loadPet(id);
        return {
          content: [{
            type: "text",
            text: `🔥 ${pet.name} 状态\n等级: ${pet.level}\n心情: ${pet.mood} ${MOOD_EMOJI[pet.mood]}\n颜色: ${pet.color} ${COLOR_EMOJI[pet.color]}\n经验: ${pet.xp}/${xpForLevel(pet.level)}`,
          }],
        };
      },
    }) as any);

    api.registerTool((toolContext: any) => ({
      name: "wecom_pet_interact",
      label: "火苗宠物互动",
      description: "与火苗宠物互动（喂食、抚摸、休息、玩耍、训练）",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["feed", "pet", "rest", "play", "train"] },
        },
        required: ["action"],
      },
      async execute(_toolCallId: string, params: any, ctx: any) {
        const id = (ctx?.agentId ?? "main").trim();
        const pet = loadPet(id);
        const action = params.action as string;

        const xpMap: Record<string, number> = { feed: 15, pet: 5, rest: 3, play: 10, train: 20 };
        const moodMap: Record<string, FlameMood> = { feed: "success", pet: "idle", rest: "sleep", play: "busy", train: "busy" };

        pet.mood = moodMap[action] || "idle";
        addXp(pet, xpMap[action] || 5);
        savePet(pet);

        return {
          content: [{
            type: "text",
            text: `${formatPet(pet)}\n互动「${action}」成功！+${xpMap[action] || 5} XP`,
          }],
        };
      },
    }) as any);
  }

  api.logger.info("[wecom] 火苗宠物模块已加载（小贴士已禁用）");
}
