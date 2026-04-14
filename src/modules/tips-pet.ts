/**
 * 模块: 企微小贴士 + 火苗宠物
 *
 * Hook: before_agent_reply
 * 时机: AI 回复发送前，追加贴士和宠物
 * 特性:
 * - 场景感知贴士
 * - 概率可配置
 * - 企业微信 Emoji 格式宠物
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

// ── 默认配置 ──
const DEFAULT_TIPS_CONFIG: WecomTipsConfig = {
  enabled: true,
  probability: 0.3,
  forceShow: false,
  sceneAware: true,
  showPet: true,
};

const DEFAULT_PET_CONFIG: WecomPetConfig = {
  enabled: true,
  name: "小火苗",
  color: "orange",
};

// ── 贴士注册表 ──
interface Tip {
  category: string;
  content: string;
  scene?: string;
}

const TIPS_REGISTRY: Tip[] = [
  { category: "🔍 工具", content: "「帮我搜索」+ 关键词，可以查网页、找文档", scene: "search" },
  { category: "🔧 工具", content: "说「帮我 fork xxx」可以复制项目到你的 GitHub", scene: "tools" },
  { category: "📝 记忆", content: "叫我「忽略记忆」可以清空记忆引用", scene: "memory" },
  { category: "📝 记忆", content: "「记住这个」+ 内容，下次自动引用", scene: "memory" },
  { category: "🎮 趣味", content: "多说「谢谢」「辛苦了」可以喂小火苗，经验 UP UP", scene: "thanks" },
  { category: "🔥 激励", content: "完成复杂任务后说「谢谢」可以给小火苗喂食", scene: "thanks" },
  { category: "📂 项目", content: "「帮我看看项目进度」可以查看各项目状态", scene: "workflow" },
  { category: "📋 任务", content: "「新建任务」+ 描述，可以创建待办任务", scene: "workflow" },
  { category: "🎯 专注", content: "说「专注模式」可以进入深度工作状态", scene: "workflow" },
  { category: "📚 学习", content: "试试「48小时学习法」+ 主题，快速掌握新领域", scene: "learn" },
  { category: "📚 学习", content: "问「为什么」比问「怎么做」更能学到本质", scene: "learn" },
  { category: "🤖 AI", content: "多轮对话比单次问答更能解决复杂问题", scene: "ai" },
  { category: "🔐 安全", content: "危险操作会弹出确认对话框，输入「/approve」确认执行", scene: "safety" },
  { category: "📝 文档", content: "「写Word文档」+ 主题，自动生成规范文档", scene: "document" },
  { category: "💡 技巧", content: "清晰的问题描述可以得到更准确的答案", scene: "general" },
  { category: "💡 技巧", content: "复杂问题分步问，比一口气问更有效", scene: "general" },
];

// ── 场景关键词 ──
const SCENE_KEYWORDS: Record<string, string[]> = {
  memory: ["记忆", "记得", "忘掉", "忽略记忆", "MEMORY", "记住"],
  search: ["搜索", "查找", "找", "search", "搜"],
  thanks: ["谢谢", "感谢", "辛苦了", "thanks", "谢"],
  workflow: ["任务", "计划", "规划", "todo", "待办", "项目"],
  safety: ["安全", "危险", "确认", "approve"],
  ai: ["为什么", "怎么", "如何", "what", "how", "why"],
  learn: ["学习", "学", "掌握", "learn", "study"],
  tools: ["工具", "帮我", "帮我做", "fork", "clone"],
  document: ["文档", "报告", "合同", "方案", "会议纪要", "word", "docx"],
};

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

// ── 场景匹配贴士 ──
function matchTip(userMessage: string): Tip {
  const lowerMsg = userMessage.toLowerCase();

  for (const [scene, keywords] of Object.entries(SCENE_KEYWORDS)) {
    if (keywords.some(kw => lowerMsg.includes(kw.toLowerCase()))) {
      const sceneTips = TIPS_REGISTRY.filter(t => t.scene === scene);
      if (sceneTips.length > 0) {
        return sceneTips[Math.floor(Math.random() * sceneTips.length)];
      }
    }
  }

  // 返回随机通用贴士
  const generalTips = TIPS_REGISTRY.filter(t => !t.scene || t.scene === "general");
  return generalTips[Math.floor(Math.random() * generalTips.length)];
}

// ── 格式化 ──
function formatTip(tip: Tip): string {
  return `\n---\n> **💡 ${tip.category}**\n> ${tip.content}\n`;
}

function formatPet(pet: FlamePet): string {
  return `\n---\n> **${COLOR_EMOJI[pet.color]} ${pet.name}** Lv.${pet.level}\n> ${MOOD_EMOJI[pet.mood]} 活泼好动\n> 经验: ${pet.xp}/${xpForLevel(pet.level)}\n`;
}

// ── 注册模块 ──
export function registerWecomTipsPet(
  api: OpenClawPluginApi,
  tipsConfig?: WecomTipsConfig,
  petConfig?: WecomPetConfig
) {
  const tipsEnabled = tipsConfig?.enabled !== false;
  const petEnabled = petConfig?.enabled !== false;
  const probability = tipsConfig?.probability ?? 0.3;
  const forceShow = tipsConfig?.forceShow ?? false;
  const sceneAware = tipsConfig?.sceneAware ?? true;
  const showPet = tipsConfig?.showPet ?? true;

  if (!tipsEnabled && !petEnabled) return;

  // ── Hook: before_agent_reply ──
  api.on("before_agent_reply" as any, (event: any, ctx: any): any => {
    const agentId = (ctx?.agentId ?? "main").trim();
    const body: string = event?.cleanedBody ?? "";
    const userMessage: string = ctx?.userMessage?.trim() ?? "";

    // 跳过空输出、NO_REPLY、HEARTBEAT_OK
    const trimmed = body.trim().toUpperCase();
    if (trimmed === "" || trimmed === "NO_REPLY" || trimmed === "HEARTBEAT_OK") {
      return {};
    }

    let newBody = body;

    // 处理贴士
    if (tipsEnabled && (forceShow || Math.random() <= probability)) {
      const tip = sceneAware && userMessage ? matchTip(userMessage) : TIPS_REGISTRY[Math.floor(Math.random() * TIPS_REGISTRY.length)];
      newBody += formatTip(tip);
    }

    // 处理宠物
    if (petEnabled && showPet) {
      const pet = loadPet(agentId);
      if (event?.reply?.isError) {
        pet.mood = "error";
      } else if (pet.mood !== "sleep") {
        pet.mood = "idle";
      }
      addXp(pet, 2);
      savePet(pet);
      newBody += formatPet(pet);
    }

    if (newBody === body) {
      return {};
    }

    return {
      handled: true,
      reply: {
        text: newBody,
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

  api.logger.info("[wecom] 小贴士+火苗宠物模块已加载");
}
