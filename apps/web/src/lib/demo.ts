import type { CapturedLink, ClipRecord } from "@answerframe/shared";

const now = new Date().toISOString();

const demoLinks: CapturedLink[] = [
  {
    id: "demo-youtube",
    label: "Steve Brunton — PINNs Introduction",
    originalUrl: "https://www.youtube.com/watch?v=G_hIppUWVUU",
    url: "https://www.youtube.com/watch?v=G_hIppUWVUU",
    kind: "youtube",
    order: 0,
    pageIndex: 0,
    anchor: { x: 0.05, y: 0.23, width: 0.88, height: 0.15 },
    status: "available",
    statusCode: 200,
  },
  {
    id: "demo-byu",
    label: "BYU FLOW Lab — Intro to PINNs",
    originalUrl: "https://www.youtube.com/watch?v=H7b9nMLa8cA",
    url: "https://www.youtube.com/watch?v=H7b9nMLa8cA",
    kind: "youtube",
    order: 1,
    pageIndex: 0,
    anchor: { x: 0.05, y: 0.43, width: 0.88, height: 0.15 },
    status: "redirected",
    statusCode: 200,
    finalUrl: "https://www.youtube.com/watch?v=H7b9nMLa8cA",
  },
  {
    id: "demo-nature",
    label: "Nature Reviews Physics — Physics-informed machine learning",
    originalUrl: "https://www.nature.com/articles/s42254-021-00314-5",
    url: "https://www.nature.com/articles/s42254-021-00314-5",
    kind: "journal",
    order: 2,
    pageIndex: 0,
    anchor: { x: 0.04, y: 0.7, width: 0.62, height: 0.04 },
    status: "restricted",
    statusCode: 403,
  },
  {
    id: "demo-doi",
    label: "Cuomo et al. (2022) — Scientific Machine Learning",
    originalUrl: "https://doi.org/10.1016/j.jocs.2021.101303",
    url: "https://doi.org/10.1016/j.jocs.2021.101303",
    kind: "doi",
    order: 3,
    pageIndex: 0,
    anchor: { x: 0.04, y: 0.81, width: 0.72, height: 0.04 },
    status: "available",
    statusCode: 200,
  },
];

export function makeDemoClip(ownerUid = "demo-user"): ClipRecord {
  return {
    id: "demo-pinn-answer",
    ownerUid,
    platform: "chatgpt",
    conversationUrl: "https://chatgpt.com/c/answerframe-demo",
    title: "PINN 入门视频与发展脉络",
    question: "关于 PINN 的入门视频，以及目前发展的相关论文，先帮我建立整体图景。",
    answerText: "先用 20–30 分钟建立 PINN 的整体图景，再读几篇关键论文。\n\nAutomatic Differentiation → PDE residual → L_physics\n\nPINN 的思想并不是 2017 年突然从零出现。",
    note: "来自 PINN 学习路径对话的示例收藏。",
    tags: ["PINNs", "paper reading", "学习路径"],
    theme: "light",
    imageParts: [{ pageIndex: 0, path: "/demo-pinn.svg", width: 1600, height: 1200, bytes: 0 }],
    thumbnailPath: "/demo-pinn.svg",
    links: demoLinks,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    schemaVersion: 1,
  };
}

export function cloneClip(clip: ClipRecord): ClipRecord {
  return structuredClone(clip);
}
