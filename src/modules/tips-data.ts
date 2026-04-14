/**
 * 智能贴士数据模块
 *
 * 模仿 Claude Code spinner tips 模式：
 * - 默认贴士池 + 用户自定义覆盖
 * - 场景感知匹配
 * - 随机选择
 */

// ── 类型 ──

export interface Tip {
  id: string;
  category: string;
  content: string;
  scene?: string;
}

export interface TipsCustomConfig {
  excludeDefault?: boolean;
  tips?: string[];
}

// ── 默认贴士池 ──

export const DEFAULT_TIPS_POOL: Tip[] = [
  { id: "search-1", category: "🔍 搜索", content: "「帮我搜索」+ 关键词，可以查网页、找文档", scene: "search" },
  { id: "tools-1", category: "🔧 工具", content: "说「帮我 fork xxx」可以复制项目到你的 GitHub", scene: "tools" },
  { id: "memory-1", category: "📝 记忆", content: "「记住这个」+ 内容，下次对话自动引用", scene: "memory" },
  { id: "memory-2", category: "📝 记忆", content: "叫我「忽略记忆」可以清空记忆引用", scene: "memory" },
  { id: "pet-1", category: "🎮 趣味", content: "多说「谢谢」「辛苦了」可以喂小火苗，经验 UP UP", scene: "thanks" },
  { id: "pet-2", category: "🔥 激励", content: "完成复杂任务后说「谢谢」可以给小火苗喂食", scene: "thanks" },
  { id: "project-1", category: "📂 项目", content: "「帮我看看项目进度」可以查看各项目状态", scene: "workflow" },
  { id: "task-1", category: "📋 任务", content: "「新建任务」+ 描述，可以创建待办任务", scene: "workflow" },
  { id: "focus-1", category: "🎯 专注", content: "说「专注模式」可以进入深度工作状态", scene: "workflow" },
  { id: "learn-1", category: "📚 学习", content: "试试「48小时学习法」+ 主题，快速掌握新领域", scene: "learn" },
  { id: "learn-2", category: "📚 学习", content: "问「为什么」比问「怎么做」更能学到本质", scene: "learn" },
  { id: "ai-1", category: "🤖 AI", content: "多轮对话比单次问答更能解决复杂问题", scene: "ai" },
  { id: "safety-1", category: "🔐 安全", content: "危险操作会弹出确认对话框，输入「/approve」确认执行", scene: "safety" },
  { id: "doc-1", category: "📝 文档", content: "「写Word文档」+ 主题，自动生成规范文档", scene: "document" },
  { id: "general-1", category: "💡 技巧", content: "清晰的问题描述可以得到更准确的答案" },
  { id: "general-2", category: "💡 技巧", content: "复杂问题分步问，比一口气问更有效" },
];

// ── 场景关键词 ──

export const SCENE_KEYWORDS: Record<string, string[]> = {
  memory: ["记忆", "记得", "忘掉", "忽略记忆", "记住"],
  search: ["搜索", "查找", "找", "搜"],
  thanks: ["谢谢", "感谢", "辛苦了", "谢"],
  workflow: ["任务", "计划", "规划", "待办", "项目"],
  safety: ["安全", "危险", "确认", "approve"],
  ai: ["为什么", "怎么", "如何"],
  learn: ["学习", "学", "掌握"],
  tools: ["工具", "帮我", "fork", "clone"],
  document: ["文档", "报告", "合同", "方案", "会议纪要", "word", "docx"],
};

// ── 贴士选择 ──

export function matchTipForScene(userMessage: string, pool: Tip[]): Tip {
  const lowerMsg = userMessage.toLowerCase();

  for (const [scene, keywords] of Object.entries(SCENE_KEYWORDS)) {
    if (keywords.some((kw) => lowerMsg.includes(kw.toLowerCase()))) {
      const sceneTips = pool.filter((t) => t.scene === scene);
      if (sceneTips.length > 0) {
        return sceneTips[Math.floor(Math.random() * sceneTips.length)];
      }
    }
  }

  return selectRandomTip(pool);
}

export function selectRandomTip(pool: Tip[]): Tip {
  return pool[Math.floor(Math.random() * pool.length)];
}

// ── 贴士池构建 ──

export function buildEffectivePool(
  customConfig?: TipsCustomConfig,
): Tip[] {
  const base = customConfig?.excludeDefault ? [] : [...DEFAULT_TIPS_POOL];

  if (customConfig?.tips && customConfig.tips.length > 0) {
    for (let i = 0; i < customConfig.tips.length; i++) {
      base.push({
        id: `custom-${i}`,
        category: "💡 自定义",
        content: customConfig.tips[i],
      });
    }
  }

  return base.length > 0 ? base : DEFAULT_TIPS_POOL;
}

// ── 格式化 ──

export function formatTipBlock(tip: Tip): string {
  return `\n---\n> **💡 小贴士** | ${tip.category}\n> ${tip.content}\n`;
}
