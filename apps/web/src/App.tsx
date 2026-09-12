import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent, type ReactNode } from "react";
import {
  Archive,
  ArrowLeft,
  BookOpen,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  ExternalLink,
  FileText,
  Filter,
  Grid2X2,
  Link2,
  List,
  LogIn,
  LogOut,
  Menu,
  Maximize2,
  MoreHorizontal,
  Plus,
  RotateCcw,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  Tag,
  Trash2,
  Upload,
  X,
  Youtube,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import {
  classifyLink,
  layoutSourceRail,
  linkStatusLabel,
  normalizeUrl,
  type CaptureDraft,
  type CapturedLink,
  type ClipPatch,
  type ClipRecord,
  type LinkKind,
  type LinkStatus,
  type Platform,
  type RailItem,
  type ScreenshotPart,
} from "@answerframe/shared";
import { hasOwnerClaim, firebaseEnabled, signInWithGoogle, signOutAnswerFrame, subscribeToAuth, type User } from "./lib/firebase";
import { createRepository, isNativeLibraryPage, resolveImageUrl, type ClipRepository } from "./lib/repository";

type Route = "library" | "trash" | "settings" | "detail";
type ViewMode = "grid" | "list";
type SaveConfirmation = { id: string; title: string };

function locationPath(): string {
  if (isNativeLibraryPage()) return window.location.hash.replace(/^#/, "") || "/library";
  return window.location.pathname;
}

const routeFromLocation = (): Route => {
  const path = locationPath();
  if (path === "/trash") return "trash";
  if (path === "/settings") return "settings";
  if (path.startsWith("/clip/")) return "detail";
  return "library";
};

function timestampToDate(value: ClipRecord["createdAt"]): Date {
  if (typeof value === "string") return new Date(value);
  return new Date(value.seconds * 1000);
}

function formatDate(value: ClipRecord["createdAt"]): string {
  const date = timestampToDate(value);
  if (Number.isNaN(date.getTime())) return "刚刚";
  return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric", year: "numeric" }).format(date);
}

function navigate(path: string): void {
  if (isNativeLibraryPage()) {
    window.location.hash = path;
    return;
  }
  window.history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

function displayUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}${parsed.pathname === "/" ? "" : parsed.pathname}`.replace(/\/$/, "");
  } catch {
    return url || "未解析 URL";
  }
}

function kindLabel(kind: LinkKind): string {
  return { youtube: "YouTube", doi: "DOI", pdf: "PDF", journal: "文献", general: "网页" }[kind];
}

function platformLabel(platform: Platform): string {
  return platform === "gemini" ? "Gemini" : "ChatGPT";
}

function statusTone(status: LinkStatus): string {
  return `status-${status}`;
}

function App() {
  const nativeLibrary = isNativeLibraryPage();
  const [route, setRoute] = useState<Route>(routeFromLocation);
  const [user, setUser] = useState<User | null>(null);
  const [ownerAllowed, setOwnerAllowed] = useState(false);
  const [repo, setRepo] = useState<ClipRepository>(() => createRepository());
  const [clips, setClips] = useState<ClipRecord[]>([]);
  const [trash, setTrash] = useState<ClipRecord[]>([]);
  const [selectedId, setSelectedId] = useState(() => locationPath().split("/").pop() || "");
  const [viewMode, setViewMode] = useState<ViewMode>("grid");
  const [query, setQuery] = useState("");
  const [platformFilter, setPlatformFilter] = useState<Platform | "all">("all");
  const [tagFilter, setTagFilter] = useState("all");
  const [kindFilter, setKindFilter] = useState("all");
  const [toast, setToast] = useState<string | null>(null);
  const [saveConfirmation, setSaveConfirmation] = useState<SaveConfirmation | null>(null);
  const [importDraft, setImportDraft] = useState<PendingDraft | null>(null);
  const [mobileMenu, setMobileMenu] = useState(false);
  const autoSaveTransferIds = useRef(new Set<string>());

  const notify = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast((current) => (current === message ? null : current)), 3200);
  };

  const reload = async (nextRepo = repo) => {
    try {
      const [active, deleted] = await Promise.all([nextRepo.list(false), nextRepo.list(true)]);
      setClips(active);
      setTrash(deleted.filter((clip) => Boolean(clip.deletedAt)));
    } catch (error) {
      notify(error instanceof Error ? error.message : "读取收藏失败");
    }
  };

  useEffect(() => {
    if (nativeLibrary) {
      setUser(null);
      setOwnerAllowed(false);
      setRepo(createRepository());
      return () => undefined;
    }
    return subscribeToAuth((nextUser) => {
    setUser(nextUser);
    void hasOwnerClaim(nextUser).catch(() => false).then((allowed) => {
      setOwnerAllowed(allowed);
      const nextRepo = createRepository(allowed ? nextUser?.uid : undefined);
      setRepo(nextRepo);
      void reload(nextRepo);
    });
    });
  }, [nativeLibrary]);

  useEffect(() => {
    void reload();
  }, [repo]);

  useEffect(() => {
    const onPopState = () => {
      setRoute(routeFromLocation());
      setSelectedId(locationPath().split("/").pop() || "");
    };
    window.addEventListener("popstate", onPopState);
    window.addEventListener("hashchange", onPopState);
    return () => { window.removeEventListener("popstate", onPopState); window.removeEventListener("hashchange", onPopState); };
  }, []);

  const selectedClip = clips.find((clip) => clip.id === selectedId) || trash.find((clip) => clip.id === selectedId) || null;
  const allTags = useMemo(() => Array.from(new Set(clips.flatMap((clip) => clip.tags))).sort(), [clips]);
  const allKinds = useMemo(() => Array.from(new Set(clips.flatMap((clip) => clip.links.map((link) => link.kind)))).sort(), [clips]);
  const allPlatforms = useMemo(() => Array.from(new Set(clips.map((clip) => clip.platform))).sort(), [clips]);
  const filteredClips = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return clips.filter((clip) => {
      const haystack = [clip.title, clip.question, clip.answerText, clip.note, clip.tags.join(" "), ...clip.links.map((link) => `${link.label} ${link.url}`)].join(" ").toLowerCase();
      return (!needle || haystack.includes(needle)) && (platformFilter === "all" || clip.platform === platformFilter) && (tagFilter === "all" || clip.tags.includes(tagFilter)) && (kindFilter === "all" || clip.links.some((link) => link.kind === kindFilter));
    });
  }, [clips, query, platformFilter, tagFilter, kindFilter]);

  const saveDraft = useCallback(async (draft: CaptureDraft, metadata: { title?: string; note?: string; tags?: string[] }, transferId?: string): Promise<boolean> => {
    setSaveConfirmation(null);
    try {
      const record = await repo.saveDraft(draft, metadata);
      await reload();
      setImportDraft(null);
      setSelectedId(record.id);
      navigate(`/clip/${record.id}`);
      setSaveConfirmation({ id: record.id, title: record.title });
      notify("已保存到 AnswerFrame");
      if (transferId) window.postMessage({ type: "answerframe:save-result", transferId, ok: true, clipId: record.id }, window.location.origin);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : "上传失败，未产生半成品记录";
      notify(message);
      if (transferId) window.postMessage({ type: "answerframe:save-result", transferId, ok: false, error: message }, window.location.origin);
      return false;
    }
  }, [repo]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.data?.type !== "answerframe:draft") return;
      const draft = event.data.draft as CaptureDraft & { _metadata?: { title?: string; note?: string; tags?: string[] } };
      if ((draft?.platform !== "chatgpt" && draft?.platform !== "gemini") || !Array.isArray(draft.screenshotParts)) return;
      if (event.data?.requestId) window.postMessage({ type: "answerframe:draft-ack", requestId: event.data.requestId }, window.location.origin);
      const transferId = typeof event.data?.transferId === "string" ? event.data.transferId : "";
      if (event.data?.autoSave === true && transferId) {
        if (autoSaveTransferIds.current.has(transferId)) return;
        autoSaveTransferIds.current.add(transferId);
        void saveDraft(draft, draft._metadata || {}, transferId);
        return;
      }
      setImportDraft(draft);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [saveDraft]);

  const updateClip = async (id: string, patch: ClipPatch) => {
    try {
      await repo.update(id, patch);
      await reload();
      notify("已保存修改");
    } catch (error) {
      notify(error instanceof Error ? error.message : "修改失败");
    }
  };

  const deleteClip = async (id: string, permanent = false) => {
    try {
      if (permanent) await repo.purge(id);
      else await repo.softDelete(id);
      await reload();
      if (!permanent) {
        navigate("/library");
        notify("已移入回收站，可在 30 天内恢复");
      } else notify("已永久删除");
    } catch (error) {
      notify(error instanceof Error ? error.message : "删除失败");
    }
  };

  const restoreClip = async (id: string) => {
    try {
      await repo.restore(id);
      await reload();
      notify("已恢复到收藏库");
    } catch (error) {
      notify(error instanceof Error ? error.message : "恢复失败");
    }
  };

  const recheckLinks = async (id: string) => {
    try {
      await repo.recheckLinks(id);
      await reload();
      notify(firebaseEnabled && !nativeLibrary ? "已请求重新检查来源" : "已标记来源待检查；当前本地库不访问外部链接");
    } catch (error) {
      notify(error instanceof Error ? error.message : "链接检查失败");
    }
  };

  const signIn = async () => {
    if (nativeLibrary) {
      notify("扩展原生资料库不需要登录，也不会上传到云端");
      return;
    }
    if (!firebaseEnabled) {
      notify("当前是 Demo 模式；配置 Firebase 后即可 Google 登录");
      return;
    }
    try {
      await signInWithGoogle();
    } catch (error) {
      notify(error instanceof Error ? error.message : "Google 登录失败");
    }
  };

  return (
    <div className="app-shell">
      <Sidebar route={route} mobileMenu={mobileMenu} onNavigate={(next) => { setMobileMenu(false); navigate(next === "library" ? "/library" : `/${next}`); }} onClose={() => setMobileMenu(false)} />
      <div className="app-main">
        <header className="topbar">
          <button className="icon-button mobile-only" aria-label="打开菜单" onClick={() => setMobileMenu(true)}><Menu size={19} /></button>
          <div className="topbar-search"><Search size={17} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索标题、问题、标签或链接…" /></div>
          <div className="topbar-actions">
            <span className={`mode-pill ${firebaseEnabled && ownerAllowed && !nativeLibrary ? "cloud" : "demo"}`}><span className="mode-dot" />{nativeLibrary ? "Local extension library" : firebaseEnabled && ownerAllowed ? "Cloud library" : "Demo mode"}</span>
            {!nativeLibrary && (user ? <button className="account-button" onClick={() => void signOutAnswerFrame()} title="退出登录"><span className="avatar">{(user.displayName || user.email || "A").slice(0, 1).toUpperCase()}</span><span className="account-name">{user.displayName || user.email}</span><LogOut size={15} /></button> : <button className="button button-quiet" onClick={() => void signIn()}><LogIn size={16} />Google 登录</button>)}
          </div>
        </header>
        {nativeLibrary ? <div className="demo-banner"><ShieldCheck size={16} />扩展原生资料库：不需要运行 localhost 或终端。截图和元数据仅保存在这个 Chrome 配置文件中。</div> : !firebaseEnabled && <div className="demo-banner"><Sparkles size={16} />这是可安全试用的本地 Demo；截图保存在当前浏览器的 IndexedDB 中。填入 <code>VITE_FIREBASE_*</code> 后，确认保存会上传到你的私有 Firebase 项目。</div>}
        <main className="content-area">
          {route === "library" && <LibraryPage nativeLibrary={nativeLibrary} clips={filteredClips} allPlatforms={allPlatforms} platformFilter={platformFilter} setPlatformFilter={setPlatformFilter} allTags={allTags} allKinds={allKinds} tagFilter={tagFilter} kindFilter={kindFilter} setTagFilter={setTagFilter} setKindFilter={setKindFilter} viewMode={viewMode} setViewMode={setViewMode} onOpen={(id) => { setSelectedId(id); navigate(`/clip/${id}`); }} />}
          {route === "detail" && selectedClip && <DetailPage clip={selectedClip} repo={repo} onBack={() => navigate("/library")} onUpdate={updateClip} onDelete={() => void deleteClip(selectedClip.id)} onRecheck={() => void recheckLinks(selectedClip.id)} onNotify={notify} />}
          {route === "detail" && !selectedClip && <EmptyState icon={<CircleHelp />} title="找不到这条收藏" actionLabel="回到收藏库" onAction={() => navigate("/library")} />}
          {route === "trash" && <TrashPage clips={trash} onRestore={(id) => void restoreClip(id)} onPurge={(id) => void deleteClip(id, true)} />}
          {route === "settings" && <SettingsPage nativeLibrary={nativeLibrary} user={user} ownerAllowed={ownerAllowed} firebaseReady={firebaseEnabled} onSignIn={() => void signIn()} />}
        </main>
      </div>
      {importDraft && <ImportModal draft={importDraft} onCancel={() => setImportDraft(null)} onConfirm={(draft, metadata) => saveDraft(draft, metadata)} />}
      {toast && <div className="toast" role="status"><Check size={16} />{toast}</div>}
      {saveConfirmation && <div className="save-success" data-testid="save-success" role="alert" aria-live="polite">
        <div className="save-success-copy"><span className="save-success-icon"><Check size={17} /></span><div><strong>保存成功</strong><span>已加入收藏库：{saveConfirmation.title}</span></div></div>
        <div className="save-success-actions"><button className="button button-quiet" onClick={() => { const id = saveConfirmation.id; setSaveConfirmation(null); navigate(`/clip/${id}`); }}>查看详情</button><button className="icon-button" aria-label="关闭保存成功提示" onClick={() => setSaveConfirmation(null)}><X size={16} /></button></div>
      </div>}
    </div>
  );
}

function Sidebar({ route, mobileMenu, onNavigate, onClose }: { route: Route; mobileMenu: boolean; onNavigate: (route: Exclude<Route, "detail">) => void; onClose: () => void }) {
  return <aside className={`sidebar ${mobileMenu ? "sidebar-open" : ""}`}>
    <div className="brand-row"><div className="brand-mark"><span>⌁</span></div><div><div className="brand-name">AnswerFrame</div><div className="brand-subtitle">Visual AI Answer Library</div></div><button className="icon-button mobile-only" onClick={onClose} aria-label="关闭菜单"><X size={18} /></button></div>
    <div className="sidebar-divider" />
    <nav className="primary-nav">
      <NavButton active={route === "library" || route === "detail"} icon={<BookOpen size={18} />} label="收藏库" onClick={() => onNavigate("library")} />
      <NavButton active={route === "trash"} icon={<Trash2 size={18} />} label="回收站" count={route === "trash" ? undefined : undefined} onClick={() => onNavigate("trash")} />
    </nav>
    <div className="sidebar-section-label">WORKSPACE</div>
    <nav className="secondary-nav">
      <NavButton active={route === "settings"} icon={<Settings size={17} />} label="设置" onClick={() => onNavigate("settings")} />
      <NavButton active={false} icon={<CircleHelp size={17} />} label="使用说明" onClick={() => window.open("https://github.com/franklai-rise/AnswerFrame", "_blank", "noopener,noreferrer")} />
    </nav>
    <div className="sidebar-bottom"><div className="privacy-note"><ShieldCheck size={16} /><span><strong>Private by default</strong><br />你的回答只属于你的资料库</span></div><div className="version-label">AnswerFrame v0.3.3 · Capture the answer.</div></div>
  </aside>;
}

function NavButton({ active, icon, label, count, onClick }: { active: boolean; icon: ReactNode; label: string; count?: number; onClick: () => void }) {
  return <button className={`nav-button ${active ? "active" : ""}`} onClick={onClick}>{icon}<span>{label}</span>{typeof count === "number" && <span className="nav-count">{count}</span>}</button>;
}

function LibraryPage({ nativeLibrary, clips, allPlatforms, platformFilter, setPlatformFilter, allTags, allKinds, tagFilter, kindFilter, setTagFilter, setKindFilter, viewMode, setViewMode, onOpen }: { nativeLibrary: boolean; clips: ClipRecord[]; allPlatforms: Platform[]; platformFilter: Platform | "all"; setPlatformFilter: (value: Platform | "all") => void; allTags: string[]; allKinds: LinkKind[]; tagFilter: string; kindFilter: string; setTagFilter: (value: string) => void; setKindFilter: (value: string) => void; viewMode: ViewMode; setViewMode: (value: ViewMode) => void; onOpen: (id: string) => void }) {
  return <>
    <div className="page-heading"><div><div className="eyebrow">YOUR COLLECTION</div><h1>收藏库</h1><p>把值得再次阅读的 AI 回答，连同它的上下文和来源放在一起。</p></div>{!nativeLibrary && <button className="button button-primary" onClick={() => window.open("/import", "_blank")}><Plus size={17} />从扩展导入</button>}</div>
    <div className="toolbar"><div className="filter-group"><div className="filter-control"><Sparkles size={15} /><select aria-label="平台筛选" value={platformFilter} onChange={(event) => setPlatformFilter(event.target.value as Platform | "all")}><option value="all">所有平台</option>{allPlatforms.map((platform) => <option key={platform} value={platform}>{platformLabel(platform)}</option>)}</select></div><div className="filter-control"><Filter size={15} /><select aria-label="标签筛选" value={tagFilter} onChange={(event) => setTagFilter(event.target.value)}><option value="all">所有标签</option>{allTags.map((tag) => <option key={tag} value={tag}>{tag}</option>)}</select></div><div className="filter-control"><Link2 size={15} /><select aria-label="链接类型筛选" value={kindFilter} onChange={(event) => setKindFilter(event.target.value)}><option value="all">所有来源</option>{allKinds.map((kind) => <option key={kind} value={kind}>{kindLabel(kind)}</option>)}</select></div></div><div className="view-switcher"><button className={viewMode === "grid" ? "selected" : ""} onClick={() => setViewMode("grid")} aria-label="卡片网格"><Grid2X2 size={17} /></button><button className={viewMode === "list" ? "selected" : ""} onClick={() => setViewMode("list")} aria-label="紧凑列表"><List size={18} /></button></div></div>
    {clips.length === 0 ? <EmptyState icon={<Archive />} title="还没有匹配的收藏" description="试试清空搜索和筛选，或在 ChatGPT / Gemini 回答下方点击 Save to AnswerFrame。" /> : viewMode === "grid" ? <div className="clip-grid">{clips.map((clip) => <ClipCard key={clip.id} clip={clip} onOpen={onOpen} />)}</div> : <div className="clip-list">{clips.map((clip) => <ClipListRow key={clip.id} clip={clip} onOpen={onOpen} />)}</div>}
  </>;
}

function ClipCard({ clip, onOpen }: { clip: ClipRecord; onOpen: (id: string) => void }) {
  return <article className="clip-card" onClick={() => onOpen(clip.id)} tabIndex={0} onKeyDown={(event) => { if (event.key === "Enter") onOpen(clip.id); }}>
    <div className="clip-card-image"><ResolvedImage path={clip.thumbnailPath || clip.imageParts[0]?.path} alt="收藏截图预览" /><div className="image-overlay"><span><Link2 size={13} />{clip.links.length} 个来源</span><span>{clip.theme === "dark" ? "Dark" : "Light"}</span></div></div>
    <div className="clip-card-body"><div className="clip-card-meta"><span>{formatDate(clip.createdAt)}</span><span className={`platform-dot ${clip.platform}`}><span />{platformLabel(clip.platform)}</span></div><h2>{clip.title}</h2><p>{clip.question}</p><div className="tag-row">{clip.tags.slice(0, 3).map((tag) => <span className="tag-chip" key={tag}><Tag size={11} />{tag}</span>)}</div></div><div className="clip-card-arrow"><ChevronRight size={17} /></div>
  </article>;
}

function ClipListRow({ clip, onOpen }: { clip: ClipRecord; onOpen: (id: string) => void }) {
  return <button className="clip-list-row" onClick={() => onOpen(clip.id)}><div className="list-thumb"><ResolvedImage path={clip.thumbnailPath || clip.imageParts[0]?.path} alt="" /></div><div className="list-main"><strong>{clip.title}</strong><span>{clip.question}</span></div><div className="list-tags">{clip.tags.slice(0, 2).map((tag) => <span className="tag-chip" key={tag}>{tag}</span>)}</div><span className="list-links"><Link2 size={14} />{clip.links.length}</span><span className="list-date">{formatDate(clip.createdAt)}</span><ChevronRight size={17} /></button>;
}

function DetailPage({ clip, repo, onBack, onUpdate, onDelete, onRecheck, onNotify }: { clip: ClipRecord; repo: ClipRepository; onBack: () => void; onUpdate: (id: string, patch: ClipPatch) => Promise<void>; onDelete: () => void; onRecheck: () => void; onNotify: (message: string) => void }) {
  const [editing, setEditing] = useState(false);
  return <div className="detail-page"><button className="back-button" onClick={onBack}><ArrowLeft size={16} />返回收藏库</button><div className="detail-header"><div><div className="eyebrow">SAVED ANSWER · {formatDate(clip.createdAt)}</div><h1>{clip.title}</h1><div className="detail-byline"><span className={`platform-dot ${clip.platform}`}><span />{platformLabel(clip.platform)}</span><a href={clip.conversationUrl} target="_blank" rel="noreferrer">打开原对话 <ExternalLink size={13} /></a></div></div><div className="detail-actions"><button className="button button-quiet" onClick={() => setEditing((value) => !value)}>{editing ? <X size={16} /> : <FileText size={16} />}{editing ? "关闭编辑" : "编辑"}</button>{!editing && <button className="button button-quiet" onClick={onRecheck}><RotateCcw size={15} />Recheck links</button>}<button className="icon-button" aria-label="更多操作"><MoreHorizontal size={18} /></button></div></div>{editing ? <ClipEditor clip={clip} repo={repo} onSave={async (patch) => { await onUpdate(clip.id, patch); setEditing(false); }} onNotify={onNotify} /> : <div className="detail-content"><section className="question-box"><div className="section-kicker">USER QUESTION</div><p>{clip.question}</p></section><div className="detail-stats"><span><Link2 size={15} />{clip.links.length} 个来源</span><span><Tag size={15} />{clip.tags.length} 个标签</span><span className={`theme-badge ${clip.theme}`} />{clip.theme === "dark" ? "深色主题" : "浅色主题"}</div><VisualSourceRail clip={clip} /><section className="answer-text"><div className="section-kicker">ANSWER TEXT</div><p>{clip.answerText}</p></section>{clip.note && <section className="note-box"><div className="section-kicker">NOTE</div><p>{clip.note}</p></section>}<div className="detail-footer"><span>最后更新 {formatDate(clip.updatedAt)}</span><button className="danger-button" onClick={onDelete}><Trash2 size={15} />移入回收站</button></div></div>}</div>;
}

function VisualSourceRail({ clip }: { clip: ClipRecord }) {
  const [hovered, setHovered] = useState<string | null>(null);
  const [activePart, setActivePart] = useState(0);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const part = clip.imageParts[activePart] || clip.imageParts[0];
  const screenshotHeight = 620;
  const railItems = useMemo(() => layoutSourceRail(clip.links.filter((link) => link.pageIndex === activePart), screenshotHeight, 82, 14), [clip.links, activePart]);
  const hoveredSource = hovered ? clip.links.find((link) => link.id === hovered) : undefined;
  const hoveredItem = hovered ? railItems.find((link) => link.id === hovered) : undefined;
  const highlightStyle = hoveredSource ? {
    left: `${hoveredSource.anchor.x * 100}%`,
    top: `${hoveredSource.anchor.y * 100}%`,
    width: `${Math.max(hoveredSource.anchor.width * 100, 5)}%`,
    height: `${Math.max(hoveredSource.anchor.height * 100, 2)}%`,
  } : undefined;

  return <section className="visual-section">
    <div className="visual-heading">
      <div><div className="section-kicker">CAPTURED Q&amp;A</div><p>点击截图可放大，滚轮缩放并拖拽查看；悬停来源卡片可定位链接。</p></div>
      {clip.imageParts.length > 1 && <div className="part-switcher">{clip.imageParts.map((image, index) => <button className={activePart === index ? "active" : ""} key={image.path} onClick={() => setActivePart(index)}>第 {index + 1} 页</button>)}</div>}
    </div>
    <div className="visual-shell">
      <div className="screenshot-stage zoomable" role="button" tabIndex={0} aria-label={`放大查看第 ${activePart + 1} 页截图`} onClick={() => setLightboxOpen(true)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setLightboxOpen(true); } }}><ResolvedImage path={part?.path} alt="AI 问答截图" /><div className="hover-highlight" style={highlightStyle} /><span className="zoom-hint"><ZoomIn size={15} />点击放大</span></div>
      <div className="rail-column"><div className="rail-label"><span />SOURCE RAIL</div><div className="source-rail" style={{ minHeight: `${screenshotHeight}px` }}>{railItems.map((item) => <SourceCard item={item} key={item.id} hovered={hovered === item.id} onHover={() => setHovered(item.id)} onLeave={() => setHovered(null)} />)}</div></div>
      <svg className="connector-layer" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">{hoveredSource && hoveredItem && <path d={`M ${Math.min((hoveredSource.anchor.x + hoveredSource.anchor.width) * 100, 98)} ${(hoveredSource.anchor.y + Math.max(hoveredSource.anchor.height, .012) / 2) * 100} C 74 ${(hoveredSource.anchor.y + Math.max(hoveredSource.anchor.height, .012) / 2) * 100}, 77 ${(hoveredItem.railTop + 41) / screenshotHeight * 100}, 100 ${(hoveredItem.railTop + 41) / screenshotHeight * 100}`} />}</svg>
    </div>
    <div className="mobile-source-list">{clip.links.map((item) => <SourceCard item={{ ...item, railTop: 0, collisionOffset: 0 }} key={item.id} hovered={false} onHover={() => undefined} onLeave={() => undefined} />)}</div>
    {lightboxOpen && <ImageLightbox paths={clip.imageParts.map((image) => image.path)} initialIndex={activePart} onPageChange={setActivePart} onClose={() => setLightboxOpen(false)} />}
  </section>;
}

function ImageLightbox({ paths, initialIndex, onPageChange, onClose }: { paths: string[]; initialIndex: number; onPageChange?: (index: number) => void; onClose: () => void }) {
  const [index, setIndex] = useState(initialIndex);
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const drag = useRef<{ pointerId: number; x: number; y: number; originX: number; originY: number } | null>(null);
  const reset = useCallback(() => { setScale(1); setOffset({ x: 0, y: 0 }); }, []);
  const changePage = (next: number) => {
    const bounded = Math.max(0, Math.min(paths.length - 1, next));
    setIndex(bounded);
    onPageChange?.(bounded);
    reset();
  };
  const changeScale = (next: number) => setScale(Math.max(.5, Math.min(6, next)));

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      else if (event.key === "+" || event.key === "=") changeScale(scale * 1.2);
      else if (event.key === "-") changeScale(scale / 1.2);
      else if (event.key === "0") reset();
      else if (event.key === "ArrowLeft" && paths.length > 1) changePage(index - 1);
      else if (event.key === "ArrowRight" && paths.length > 1) changePage(index + 1);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => { document.body.style.overflow = previousOverflow; window.removeEventListener("keydown", onKeyDown); };
  }, [index, onClose, paths.length, reset, scale]);

  return <div className="image-lightbox" role="dialog" aria-modal="true" aria-label="截图大图查看器" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="lightbox-toolbar">
      <span>第 {index + 1} / {paths.length} 页 · {Math.round(scale * 100)}%</span>
      <div>
        <button onClick={() => changeScale(scale / 1.2)} aria-label="缩小"><ZoomOut size={18} /></button>
        <button onClick={reset} aria-label="恢复适合窗口"><Maximize2 size={17} /></button>
        <button onClick={() => changeScale(scale * 1.2)} aria-label="放大"><ZoomIn size={18} /></button>
        <button onClick={onClose} aria-label="关闭"><X size={20} /></button>
      </div>
    </div>
    <div className={`lightbox-canvas ${drag.current ? "dragging" : ""}`} onWheel={(event) => { event.preventDefault(); changeScale(scale * (event.deltaY < 0 ? 1.12 : .89)); }} onDoubleClick={reset} onPointerDown={(event) => { drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, originX: offset.x, originY: offset.y }; event.currentTarget.setPointerCapture(event.pointerId); }} onPointerMove={(event) => { const current = drag.current; if (!current || current.pointerId !== event.pointerId) return; setOffset({ x: current.originX + event.clientX - current.x, y: current.originY + event.clientY - current.y }); }} onPointerUp={(event) => { if (drag.current?.pointerId === event.pointerId) drag.current = null; event.currentTarget.releasePointerCapture(event.pointerId); }} onPointerCancel={() => { drag.current = null; }}>
      <div className="lightbox-image" style={{ transform: `translate3d(${offset.x}px,${offset.y}px,0) scale(${scale})` }}><ResolvedImage path={paths[index]} alt={`问答截图第 ${index + 1} 页`} /></div>
    </div>
    {paths.length > 1 && <><button className="lightbox-page previous" disabled={index === 0} onClick={() => changePage(index - 1)} aria-label="上一页"><ChevronLeft size={25} /></button><button className="lightbox-page next" disabled={index === paths.length - 1} onClick={() => changePage(index + 1)} aria-label="下一页"><ChevronRight size={25} /></button></>}
    <div className="lightbox-help">滚轮缩放 · 拖拽移动 · 双击复位 · Esc 关闭</div>
  </div>;
}

function SourceCard({ item, hovered, onHover, onLeave }: { item: RailItem; hovered: boolean; onHover: () => void; onLeave: () => void }) {
  const Icon = item.kind === "youtube" ? Youtube : item.kind === "doi" ? FileText : item.kind === "pdf" ? FileText : Link2;
  return <a className={`source-card ${hovered ? "hovered" : ""}`} style={{ top: `${item.railTop}px` }} href={item.url || undefined} target={item.url ? "_blank" : undefined} rel={item.url ? "noreferrer" : undefined} onMouseEnter={onHover} onMouseLeave={onLeave} onFocus={onHover} onBlur={onLeave} onClick={(event) => { if (!item.url) event.preventDefault(); }}><div className={`source-icon source-${item.kind}`}><Icon size={15} /></div><div className="source-card-main"><div className="source-card-top"><span>{kindLabel(item.kind)}</span><span className={`status-chip ${statusTone(item.status)}`}><span />{linkStatusLabel(item.status)}</span></div><strong>{item.label}</strong><small>{item.url ? displayUrl(item.url) : "请补充真实 URL"}</small></div><ExternalLink className="source-external" size={14} /></a>;
}

function ClipEditor({ clip, repo, onSave, onNotify }: { clip: ClipRecord; repo: ClipRepository; onSave: (patch: ClipPatch) => Promise<void>; onNotify: (message: string) => void }) {
  const [title, setTitle] = useState(clip.title);
  const [question, setQuestion] = useState(clip.question);
  const [note, setNote] = useState(clip.note);
  const [tagsText, setTagsText] = useState(clip.tags.join(", "));
  const [links, setLinks] = useState<CapturedLink[]>(clip.links.map((link) => ({ ...link })));
  const [saving, setSaving] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try { await onSave({ title: title.trim() || "Saved AI answer", question, note, tags: tagsText.split(",").map((tag) => tag.trim()).filter(Boolean), links }); } finally { setSaving(false); }
  };
  const onReplace = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) { onNotify("请选择图片文件"); return; }
    setReplacing(true);
    try {
      const dataUrl = await readFileAsDataUrl(file);
      const part: ScreenshotPart = { pageIndex: 0, dataUrl, width: 1600, height: 1000 };
      await repo.replaceScreenshot(clip.id, [part]);
      onNotify("截图已替换；刷新详情即可查看");
      window.location.reload();
    } catch (error) { onNotify(error instanceof Error ? error.message : "截图替换失败"); } finally { setReplacing(false); }
  };
  return <form className="editor-panel" onSubmit={(event) => void submit(event)}><div className="editor-header"><div><div className="section-kicker">EDIT METADATA</div><h2>整理这条收藏</h2></div><button className="button button-primary" type="submit" disabled={saving}>{saving ? "保存中…" : <><Check size={16} />保存修改</>}</button></div><label>标题<input value={title} onChange={(event) => setTitle(event.target.value)} /></label><label>用户问题<textarea rows={3} value={question} onChange={(event) => setQuestion(event.target.value)} /></label><label>笔记<textarea rows={3} value={note} onChange={(event) => setNote(event.target.value)} placeholder="写下你之后要继续追问的方向…" /></label><label>标签<input value={tagsText} onChange={(event) => setTagsText(event.target.value)} placeholder="PINNs, paper reading" /><small>用逗号分隔</small></label><div className="editor-divider" /><div className="editor-subheading"><div><div className="section-kicker">SOURCES</div><h3>链接与状态</h3></div><button className="button button-quiet" type="button" onClick={() => setLinks((items) => [...items, { id: `new-${Date.now()}`, label: "新来源", originalUrl: "", url: "", kind: "general", order: items.length, pageIndex: 0, anchor: { x: 0, y: 0, width: 0, height: 0 }, status: "unresolved" }])}><Plus size={15} />添加链接</button></div><div className="editor-links">{links.map((link, index) => <div className="editor-link-row" key={link.id}><div className="editor-link-index">{index + 1}</div><input aria-label={`来源 ${index + 1} 名称`} value={link.label} onChange={(event) => setLinks((items) => items.map((item) => item.id === link.id ? { ...item, label: event.target.value } : item))} /><input aria-label={`来源 ${index + 1} URL`} value={link.originalUrl || link.url} placeholder="https://…" onChange={(event) => setLinks((items) => items.map((item) => { if (item.id !== link.id) return item; const raw = event.target.value; const normalized = normalizeUrl(raw); return { ...item, originalUrl: raw, url: normalized || "", kind: classifyLink(raw), status: raw ? "checking" : "unresolved" }; }))} /><select value={link.kind} onChange={(event) => setLinks((items) => items.map((item) => item.id === link.id ? { ...item, kind: event.target.value as LinkKind } : item))}><option value="general">网页</option><option value="youtube">YouTube</option><option value="doi">DOI</option><option value="pdf">PDF</option><option value="journal">文献</option></select><button className="icon-button danger-icon" type="button" aria-label="删除来源" onClick={() => setLinks((items) => items.filter((item) => item.id !== link.id))}><Trash2 size={15} /></button></div>)}</div><label className="replace-upload"><Upload size={17} /><span>{replacing ? "替换中…" : "上传替换截图"}<small>保留当前主题；v1 不提供裁剪和标注</small></span><input type="file" accept="image/*" onChange={(event) => void onReplace(event)} disabled={replacing} /></label></form>;
}

function TrashPage({ clips, onRestore, onPurge }: { clips: ClipRecord[]; onRestore: (id: string) => void; onPurge: (id: string) => void }) {
  return <>
    <div className="page-heading"><div><div className="eyebrow">RECOVERY</div><h1>回收站</h1><p>删除的收藏会保留 30 天；永久删除前会再次确认。</p></div></div>
    {clips.length === 0 ? <EmptyState icon={<Trash2 />} title="回收站是空的" description="移入回收站的回答会出现在这里。" /> : <div className="trash-list">{clips.map((clip) => <div className="trash-row" key={clip.id}><div className="trash-thumb"><ResolvedImage path={clip.thumbnailPath || clip.imageParts[0]?.path} alt="" /></div><div className="trash-main"><strong>{clip.title}</strong><span>删除于 {formatDate(clip.deletedAt || clip.updatedAt)}</span></div><button className="button button-quiet" onClick={() => onRestore(clip.id)}><RotateCcw size={15} />恢复</button><button className="button button-danger" onClick={() => { if (window.confirm("永久删除后无法恢复，确定继续吗？")) onPurge(clip.id); }}><Trash2 size={15} />永久删除</button></div>)}</div>}
  </>;
}

function SettingsPage({ nativeLibrary, user, ownerAllowed, firebaseReady, onSignIn }: { nativeLibrary: boolean; user: User | null; ownerAllowed: boolean; firebaseReady: boolean; onSignIn: () => void }) {
  return <>
    <div className="page-heading"><div><div className="eyebrow">WORKSPACE</div><h1>设置</h1><p>{nativeLibrary ? "管理扩展本机资料库和保存方式。" : "控制登录、云端连接和扩展导入行为。"}</p></div></div>
    <div className="settings-grid">
      <section className="settings-card"><div className="settings-card-icon"><ShieldCheck size={18} /></div><div><h2>隐私与账号</h2><p>{nativeLibrary ? "这个版本不需要 Google 登录。截图、问题、文本和链接都只保存在当前 Chrome 配置文件的扩展 IndexedDB 中。" : firebaseReady ? "Google 登录已配置。只有带 answerframeOwner 权限的账号可以读取收藏。" : "当前未配置 Firebase，网页使用浏览器本地 IndexedDB 保存截图和元数据。"}</p>{!nativeLibrary && (user ? <div className="settings-account"><span className="avatar large">{(user.displayName || user.email || "A").slice(0, 1).toUpperCase()}</span><div><strong>{user.displayName || "Google account"}</strong><span>{user.email}</span></div><span className={`claim-badge ${ownerAllowed ? "ok" : "pending"}`}>{ownerAllowed ? "Owner enabled" : "等待 owner claim"}</span></div> : <button className="button button-primary" onClick={onSignIn}><LogIn size={16} />使用 Google 登录</button>)}</div></section>
      <section className="settings-card"><div className="settings-card-icon"><Upload size={18} /></div><div><h2>Chrome 扩展</h2><p>{nativeLibrary ? "在 ChatGPT 或 Gemini 的 assistant 回答下方点击 Save to AnswerFrame，确认预览后会直接写入这里；不需要开启 localhost，也不需要终端。" : "在 ChatGPT 或 Gemini assistant 回答下方出现 Save to AnswerFrame。确认预览后，扩展会打开此网页完成导入。"}</p><div className="install-steps"><span>1</span><div>在 Chrome 扩展页开启“开发者模式”，加载构建后的 <code>apps/extension/dist</code> 文件夹。</div><span>2</span><div>{nativeLibrary ? "点击扩展图标即可随时打开此资料库。" : "将 AnswerFrame 地址设置为当前网页地址。"}</div></div></div></section>
      <section className="settings-card wide"><div className="settings-card-icon"><CircleHelp size={18} /></div><div><h2>开发状态</h2><div className="status-table"><div><span>Native library</span><b className={nativeLibrary ? "ready-dot" : "muted-dot"}>{nativeLibrary ? "Ready" : "Standalone app"}</b></div><div><span>Firebase</span><b className={firebaseReady && !nativeLibrary ? "ready-dot" : "muted-dot"}>{firebaseReady && !nativeLibrary ? "Configured" : nativeLibrary ? "Not used" : "Demo mode"}</b></div><div><span>Link validator</span><b className="muted-dot">Not enabled locally</b></div><div><span>Chrome Web Store</span><b className="muted-dot">Not published</b></div></div></div></section>
    </div>
  </>;
}

type PendingDraft = CaptureDraft & { _metadata?: { title?: string; note?: string; tags?: string[] } };

function ImportModal({ draft, onCancel, onConfirm }: { draft: PendingDraft; onCancel: () => void; onConfirm: (draft: CaptureDraft, metadata: { title: string; note: string; tags: string[] }) => Promise<boolean> }) {
  const [question, setQuestion] = useState(draft.question);
  const [title, setTitle] = useState(draft._metadata?.title || draft.answerText.split(/\r?\n/).map((line) => line.trim()).find(Boolean)?.slice(0, 100) || "Saved AI answer");
  const [note, setNote] = useState(draft._metadata?.note || "");
  const [tags, setTags] = useState((draft._metadata?.tags || [platformLabel(draft.platform)]).join(", "));
  const [saving, setSaving] = useState(false);
  const confirm = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const saved = await onConfirm({ ...draft, question }, { title, note, tags: tags.split(",").map((tag) => tag.trim()).filter(Boolean) });
      if (!saved) setSaving(false);
    } catch {
      setSaving(false);
    }
  };
  return <div className="modal-backdrop"><section className="import-modal" role="dialog" aria-modal="true" aria-labelledby="import-title"><div className="modal-header"><div><div className="eyebrow">CAPTURE PREVIEW</div><h2 id="import-title">保存到 AnswerFrame</h2><p>先确认截图、问题和来源清单，再上传到你的私有库。</p></div><button className="icon-button" onClick={onCancel} aria-label="取消"><X size={19} /></button></div><div className="import-preview-grid"><div className="preview-shot"><ResolvedImage path={draft.screenshotParts[0]?.dataUrl} alt="回答截图预览" /><span className="preview-pages">{draft.screenshotParts.length} page{draft.screenshotParts.length > 1 ? "s" : ""}</span></div><div className="preview-meta"><label>标题<input value={title} onChange={(event) => setTitle(event.target.value)} /></label><label>用户问题<textarea rows={4} value={question} onChange={(event) => setQuestion(event.target.value)} /></label><label>笔记<textarea rows={2} value={note} onChange={(event) => setNote(event.target.value)} placeholder="稍后要继续聊什么？" /></label><label>标签<input value={tags} onChange={(event) => setTags(event.target.value)} /></label></div></div><div className="preview-links"><div className="preview-links-heading"><span><Link2 size={16} />检测到 {draft.links.length} 个来源</span><small>链接会在上传后异步检查</small></div>{draft.links.length === 0 ? <div className="unresolved-empty">未发现可解析链接；回答中的无 URL 引用仍会保留。</div> : <div className="preview-link-list">{draft.links.map((link) => <div key={link.id} className="preview-link-row"><span className={`source-icon source-${link.kind}`}>{link.kind === "youtube" ? <Youtube size={14} /> : <Link2 size={14} />}</span><span>{link.label}</span><small>{link.url || "需要补充 URL"}</small><span className={`status-chip ${statusTone(link.status)}`}><span />{linkStatusLabel(link.status)}</span></div>)}</div>}</div><div className="modal-footer"><span><ShieldCheck size={15} />只会上传截图和元数据，不上传视频或论文正文</span><div><button className="button button-quiet" onClick={onCancel}>取消</button><button className="button button-primary" onClick={confirm} disabled={saving}>{saving ? "上传中…" : <><Upload size={16} />确认并保存</>}</button></div></div></section></div>;
}

function ResolvedImage({ path, alt }: { path?: string; alt: string }) {
  const [src, setSrc] = useState(path || "");
  useEffect(() => {
    let mounted = true;
    let objectUrl = "";
    setSrc(path || "");
    if (!path) return () => undefined;
    void resolveImageUrl(path).then((value) => {
      if (!mounted) { if (value.startsWith("blob:")) URL.revokeObjectURL(value); return; }
      objectUrl = value.startsWith("blob:") ? value : "";
      setSrc(value);
    }).catch(() => { if (mounted) setSrc(""); });
    return () => { mounted = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [path]);
  if (!src) return <div className="image-placeholder"><FileText size={26} /><span>截图暂不可用</span></div>;
  return <img src={src} alt={alt} loading="lazy" />;
}

function EmptyState({ icon, title, description, actionLabel, onAction }: { icon: ReactNode; title: string; description?: string; actionLabel?: string; onAction?: () => void }) {
  return <div className="empty-state"><div className="empty-icon">{icon}</div><h2>{title}</h2>{description && <p>{description}</p>}{actionLabel && onAction && <button className="button button-primary" onClick={onAction}>{actionLabel}</button>}</div>;
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error || new Error("无法读取图片")); reader.readAsDataURL(file); });
}

export default App;
