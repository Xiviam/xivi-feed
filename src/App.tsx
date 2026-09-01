import {
  ArrowLeft,
  BadgeCheck,
  Ban,
  Bell,
  Bookmark,
  BookmarkCheck,
  Camera,
  Check,
  ChevronRight,
  Copy,
  Flag,
  Heart,
  Home as HomeIcon,
  ImagePlus,
  LoaderCircle,
  LockKeyhole,
  MailCheck,
  LogIn,
  LogOut,
  Menu,
  MessageCircle,
  MessagesSquare,
  Monitor,
  Moon,
  MoreHorizontal,
  RefreshCw,
  Search,
  Send,
  Settings,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  SquarePlus,
  Sun,
  Trash2,
  Upload,
  UserRound,
  X,
} from "lucide-react";
import QRCode from "qrcode";
import {
  createContext,
  type FormEvent,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { Link, NavLink, Navigate, Outlet, Route, Routes, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ApiError, api } from "./api";
import { useTheme, type ThemeMode } from "./theme";
import type {
  ChatMessage,
  Conversation,
  ModerationSummary,
  ModerationUser,
  Notification as XiviNotification,
  Post,
  PostReport,
  TwoFactorSetup,
  TwoFactorStatus,
  User,
} from "./types";

type AuthContextValue = {
  user: User | null;
  loading: boolean;
  setUser: (user: User | null) => void;
  refresh: () => Promise<void>;
};

type ToastItem = { id: number; message: string; tone: "good" | "bad" };

const AuthContext = createContext<AuthContextValue | null>(null);
const ToastContext = createContext<(message: string, tone?: "good" | "bad") => void>(() => undefined);

function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error("AuthProvider is missing");
  return value;
}

function useToast() {
  return useContext(ToastContext);
}

function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const result = await api.me();
      setUser(result.user);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return <AuthContext.Provider value={{ user, loading, setUser, refresh }}>{children}</AuthContext.Provider>;
}

function Toasts({ items }: { items: ToastItem[] }) {
  return (
    <div className="toast-stack" aria-live="polite">
      {items.map((item) => (
        <div className={`toast toast--${item.tone}`} key={item.id}>
          {item.tone === "good" ? <Check size={17} /> : <X size={17} />}
          {item.message}
        </div>
      ))}
    </div>
  );
}

export default function App() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextToast = useRef(1);

  const notify = useCallback((message: string, tone: "good" | "bad" = "good") => {
    const id = nextToast.current++;
    setToasts((current) => [...current, { id, message, tone }]);
    window.setTimeout(() => setToasts((current) => current.filter((item) => item.id !== id)), 3200);
  }, []);

  return (
    <AuthProvider>
      <ToastContext.Provider value={notify}>
        <Routes>
          <Route path="/login" element={<AuthPage mode="login" />} />
          <Route path="/register" element={<AuthPage mode="register" />} />
          <Route path="/forgot-password" element={<PasswordHelpPage mode="forgot" />} />
          <Route path="/reset-password" element={<PasswordHelpPage mode="reset" />} />
          <Route path="/verify-email" element={<VerifyEmailPage />} />
          <Route element={<Shell />}>
            <Route index element={<HomePage />} />
            <Route path="search" element={<SearchPage />} />
            <Route path="saved" element={<Protected><SavedPage /></Protected>} />
            <Route path="notifications" element={<Protected><NotificationsPage /></Protected>} />
            <Route path="messages" element={<Protected><MessagesPage /></Protected>} />
            <Route path="messages/:conversationId" element={<Protected><MessagesPage /></Protected>} />
            <Route path="create" element={<Protected><CreatePage /></Protected>} />
            <Route path="u/:username" element={<ProfilePage />} />
            <Route path="p/:postId" element={<PostPage />} />
            <Route path="settings/profile" element={<Protected><SettingsPage /></Protected>} />
            <Route path="admin" element={<AdminOnly><AdminPage /></AdminOnly>} />
            <Route path="*" element={<NotFoundPage />} />
          </Route>
        </Routes>
        <Toasts items={toasts} />
      </ToastContext.Provider>
    </AuthProvider>
  );
}

function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <Link to="/" className={`brand ${compact ? "brand--compact" : ""}`} aria-label="XIVI — на главную">
      <span className="brand-mark" aria-hidden="true">
        <span />
      </span>
      {!compact && <span className="brand-name">XIVI</span>}
    </Link>
  );
}

function Avatar({ user, size = "medium" }: { user: Pick<User, "username" | "displayName" | "avatarUrl">; size?: "small" | "medium" | "large" | "hero" }) {
  const [broken, setBroken] = useState(false);
  const initials = (user.displayName || user.username).trim().slice(0, 2).toUpperCase();
  return (
    <span className={`avatar avatar--${size}`} aria-hidden="true">
      {!broken && user.avatarUrl ? (
        <img src={user.avatarUrl} alt="" onError={() => setBroken(true)} />
      ) : (
        <span>{initials}</span>
      )}
    </span>
  );
}

function Shell() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const notify = useToast();
  const [menuOpen, setMenuOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const [messageUnread, setMessageUnread] = useState(0);

  useEffect(() => {
    if (!user) {
      setUnread(0);
      setMessageUnread(0);
      return;
    }
    let active = true;
    const refreshUnread = () => {
      void api.unreadNotifications()
        .then((result) => { if (active) setUnread(result.count); })
        .catch(() => undefined);
      void api.conversations()
        .then((result) => { if (active) setMessageUnread(result.unreadTotal); })
        .catch(() => undefined);
    };
    const syncMessages = (event: Event) => {
      const nextCount = event instanceof CustomEvent ? Number(event.detail) : 0;
      setMessageUnread(Number.isFinite(nextCount) ? Math.max(0, nextCount) : 0);
    };
    const syncUnread = (event: Event) => {
      const nextCount = event instanceof CustomEvent ? Number(event.detail) : 0;
      setUnread(Number.isFinite(nextCount) ? Math.max(0, nextCount) : 0);
    };
    refreshUnread();
    const timer = window.setInterval(refreshUnread, 30_000);
    window.addEventListener("xivi:notifications-read", syncUnread);
    window.addEventListener("xivi:messages-read", syncMessages);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener("xivi:notifications-read", syncUnread);
      window.removeEventListener("xivi:messages-read", syncMessages);
    };
  }, [user]);

  async function logout() {
    try {
      await api.logout();
      window.location.assign("/");
    } catch (error) {
      notify(getError(error), "bad");
    }
  }

  const profileUrl = user ? `/u/${user.username}` : "/login";

  return (
    <div className="app-shell">
      <aside className="desktop-sidebar">
        <Brand />
        <nav className="primary-nav" aria-label="Основная навигация">
          <NavItem to="/" icon={<HomeIcon />} label="Лента" end />
          <NavItem to="/search" icon={<Search />} label="Поиск" />
          {user && <NavItem to="/notifications" icon={<NavIconWithBadge icon={<Bell />} count={unread} />} label="Уведомления" />}
          {user && <NavItem to="/messages" icon={<NavIconWithBadge icon={<MessagesSquare />} count={messageUnread} />} label="Сообщения" />}
          {user && <NavItem to="/saved" icon={<Bookmark />} label="Сохранённое" />}
          <NavItem to="/create" icon={<SquarePlus />} label="Создать" />
          <NavItem to={profileUrl} icon={<UserRound />} label="Профиль" />
        </nav>
        <div className="sidebar-bottom">
          <ThemeQuickButton />
          {user ? (
            <>
              <button className="account-chip" onClick={() => navigate(profileUrl)} aria-label={`Открыть профиль @${user.username}`}>
                <Avatar user={user} size="small" />
                <span><strong>{user.displayName}</strong><small>@{user.username}</small></span>
              </button>
              <button className="nav-item" onClick={() => setMenuOpen((open) => !open)} aria-expanded={menuOpen} aria-label="Открыть дополнительное меню">
                <Menu /> <span>Ещё</span>
              </button>
              {menuOpen && (
                <div className="more-menu">
                  <Link to="/settings/profile"><Settings size={18} /> Настройки</Link>
                  {user.role === "admin" && <Link to="/admin"><Shield size={18} /> Модерация</Link>}
                  <button onClick={() => void logout()}><LogOut size={18} /> Выйти</button>
                </div>
              )}
            </>
          ) : (
            <Link to="/login" className="button button--dark button--wide"><LogIn size={18} /> Войти</Link>
          )}
        </div>
      </aside>

      <header className="mobile-header">
        <Brand />
        <div className="mobile-header-actions">
          <ThemeIconButton />
          {user && <Link className="icon-button notification-link" to="/notifications" aria-label={`Уведомления${unread ? `: ${unread} новых` : ""}`}><Bell size={22} />{unread > 0 && <span className="notification-badge">{Math.min(unread, 99)}</span>}</Link>}
          {user && <Link className="icon-button notification-link" to="/messages" aria-label={`Сообщения${messageUnread ? `: ${messageUnread} новых` : ""}`}><MessagesSquare size={22} />{messageUnread > 0 && <span className="notification-badge">{Math.min(messageUnread, 99)}</span>}</Link>}
          {user ? <Link to={profileUrl}><Avatar user={user} size="small" /></Link> : <Link className="text-link" to="/login">Войти</Link>}
        </div>
      </header>

      <main className="app-main">
        <Outlet />
      </main>

      <nav className="mobile-nav" aria-label="Мобильная навигация">
        <NavItem to="/" icon={<HomeIcon />} label="Лента" end compact />
        <NavItem to="/search" icon={<Search />} label="Поиск" compact />
        <NavItem to="/create" icon={<SquarePlus />} label="Создать" compact />
        <NavItem to={profileUrl} icon={<UserRound />} label="Профиль" compact />
      </nav>
    </div>
  );
}

function NavIconWithBadge({ icon, count }: { icon: ReactNode; count: number }) {
  return <span className="nav-icon-badge">{icon}{count > 0 && <span>{Math.min(count, 99)}</span>}</span>;
}

function ThemeQuickButton() {
  const { resolvedTheme, setTheme } = useTheme();
  const nextTheme = resolvedTheme === "dark" ? "light" : "dark";
  return (
    <button className="nav-item" onClick={() => setTheme(nextTheme)} title={`Включить ${nextTheme === "dark" ? "тёмную" : "светлую"} тему`} aria-label={`Включить ${nextTheme === "dark" ? "тёмную" : "светлую"} тему`}>
      {resolvedTheme === "dark" ? <Sun /> : <Moon />} <span>Тема</span>
    </button>
  );
}

function ThemeIconButton({ className = "" }: { className?: string }) {
  const { resolvedTheme, setTheme } = useTheme();
  const nextTheme = resolvedTheme === "dark" ? "light" : "dark";
  const label = `Включить ${nextTheme === "dark" ? "тёмную" : "светлую"} тему`;
  return <button type="button" className={`theme-icon-button ${className}`} onClick={() => setTheme(nextTheme)} aria-label={label} title={label}>{resolvedTheme === "dark" ? <Sun /> : <Moon />}</button>;
}

function NavItem({ to, icon, label, end, compact }: { to: string; icon: ReactNode; label: string; end?: boolean; compact?: boolean }) {
  return (
    <NavLink to={to} end={end} className={({ isActive }) => `nav-item ${isActive ? "is-active" : ""} ${compact ? "nav-item--compact" : ""}`}>
      {icon}<span>{label}</span>
    </NavLink>
  );
}

function Protected({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <PageLoader />;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return children;
}

function AdminOnly({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <PageLoader />;
  if (!user) return <Navigate to="/login" replace />;
  if (user.role !== "admin") return <Navigate to="/" replace />;
  return children;
}

function HomePage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [scope, setScope] = useState<"all" | "following">("all");
  const [posts, setPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [page, setPage] = useState(1);
  const [error, setError] = useState("");

  const loadFeed = useCallback(async (nextPage = 1, append = false) => {
    append ? setLoadingMore(true) : setLoading(true);
    setError("");
    try {
      const result = await api.feed(scope, nextPage);
      setPosts((current) => append ? [...current, ...result.posts] : result.posts);
      setHasMore(result.hasMore);
      setPage(nextPage);
    } catch (loadError) {
      setError(getError(loadError));
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [scope]);

  useEffect(() => {
    void loadFeed();
  }, [loadFeed]);

  function updatePost(updated: Post) {
    setPosts((current) => current.map((post) => post.id === updated.id ? updated : post));
  }

  return (
    <div className="home-layout">
      <section className="feed-column">
        <div className="feed-intro">
          <div>
            <span className="eyebrow"><Sparkles size={14} /> скидывай как есть</span>
            <h1>Фото. И ещё<br />немного фото</h1>
          </div>
          <div className="intro-orbit" aria-hidden="true"><span>D</span></div>
        </div>

        <div className="feed-tabs" role="tablist" aria-label="Выбор ленты">
          <button role="tab" aria-selected={scope === "all"} className={scope === "all" ? "active" : ""} onClick={() => setScope("all")}>Свежее</button>
          <button role="tab" aria-selected={scope === "following"} className={scope === "following" ? "active" : ""} onClick={() => user ? setScope("following") : navigate("/login", { state: { from: "/" } })}>
            Подписки {!user && <span className="lock-dot" />}
          </button>
        </div>

        {loading ? <FeedSkeleton /> : error ? (
          <ErrorState message={error} onRetry={() => void loadFeed()} />
        ) : posts.length ? (
          <div className="post-list">
            {posts.map((post) => <PostCard key={post.id} post={post} onChange={updatePost} />)}
            {hasMore && (
              <button className="button button--outline load-more" disabled={loadingMore} onClick={() => void loadFeed(page + 1, true)}>
                {loadingMore && <LoaderCircle className="spin" size={18} />} Показать ещё
              </button>
            )}
          </div>
        ) : (
          <EmptyFeed scope={scope} />
        )}
      </section>

      <aside className="right-rail">
        <ActivityCard />
        <div className="rail-section">
          <div className="rail-title"><span>Новые авторы</span><small>тоже что-то скинули</small></div>
          {uniqueAuthors(posts).slice(0, 4).map((author) => <Suggestion key={author.id} user={author} />)}
        </div>
        <p className="rail-footer">XIVI · Правила · Помощь<br />feed.xivici.space © 2026</p>
      </aside>
    </div>
  );
}

function ActivityCard() {
  return (
    <div className="city-card">
      <div className="city-card-top"><span>Сейчас в XIVI</span><span className="live-dot">live</span></div>
      <strong>1 247</strong>
      <p>публикаций уже.<br />зачем считать — неясно</p>
      <div className="city-bars" aria-hidden="true"><i /><i /><i /><i /><i /><i /><i /></div>
    </div>
  );
}

function Suggestion({ user }: { user: User }) {
  return (
    <Link className="suggestion" to={`/u/${user.username}`}>
      <Avatar user={user} size="medium" />
      <span><strong>{user.displayName}</strong><small>@{user.username}</small></span>
      <ChevronRight size={18} />
    </Link>
  );
}

function PostCard({ post, onChange, detail = false }: { post: Post; onChange: (post: Post) => void; detail?: boolean }) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const notify = useToast();
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [imageBroken, setImageBroken] = useState(false);
  const [heartBurst, setHeartBurst] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [reportCategory, setReportCategory] = useState("spam");
  const [reportDetails, setReportDetails] = useState("");

  function requireUser() {
    if (user) return true;
    navigate("/login", { state: { from: window.location.pathname } });
    return false;
  }

  async function toggleLike(forceLike = false) {
    if (!requireUser() || busy || (forceLike && post.likedByMe)) return;
    const optimistic = { ...post, likedByMe: !post.likedByMe, likesCount: post.likesCount + (post.likedByMe ? -1 : 1) };
    onChange(optimistic);
    setBusy(true);
    try {
      const result = await api.like(post.id);
      onChange({ ...post, likedByMe: result.liked, likesCount: result.likesCount });
    } catch (error) {
      onChange(post);
      notify(getError(error), "bad");
    } finally {
      setBusy(false);
    }
  }

  async function submitComment(event: FormEvent) {
    event.preventDefault();
    if (!requireUser() || !comment.trim() || busy) return;
    setBusy(true);
    try {
      const result = await api.comment(post.id, comment.trim());
      onChange({ ...post, comments: [...(post.comments ?? []), result.comment], commentsCount: post.commentsCount + 1 });
      setComment("");
    } catch (error) {
      notify(getError(error), "bad");
    } finally {
      setBusy(false);
    }
  }

  async function toggleSave() {
    if (!requireUser() || busy) return;
    setBusy(true);
    try {
      const result = await api.save(post.id);
      onChange({ ...post, savedByMe: result.saved });
      notify(result.saved ? "Сохранено в твою коллекцию." : "Убрано из сохранённого.");
    } catch (error) {
      notify(getError(error), "bad");
    } finally {
      setBusy(false);
    }
  }

  async function sharePost() {
    const url = new URL(`/p/${post.id}`, window.location.origin).toString();
    try {
      if (navigator.share) {
        await navigator.share({ title: `XIVI · @${post.author.username}`, text: post.caption || "Смотри, что нашлось в XIVI", url });
        return;
      }
      await navigator.clipboard.writeText(url);
      notify("Ссылка скопирована.");
    } catch (shareError) {
      if (shareError instanceof DOMException && shareError.name === "AbortError") return;
      notify("Не удалось поделиться ссылкой.", "bad");
    }
  }

  async function submitReport(event: FormEvent) {
    event.preventDefault();
    if (!requireUser() || busy) return;
    setBusy(true);
    try {
      await api.reportPost(post.id, { category: reportCategory, details: reportDetails.trim() });
      setReportOpen(false);
      setReportDetails("");
      notify("Жалоба отправлена модератору.");
    } catch (reportError) {
      notify(getError(reportError), "bad");
    } finally {
      setBusy(false);
    }
  }

  function doubleLike() {
    setHeartBurst(true);
    window.setTimeout(() => setHeartBurst(false), 650);
    void toggleLike(true);
  }

  return (
    <article className={`post-card ${detail ? "post-card--detail" : ""}`}>
      <header className="post-header">
        <Link to={`/u/${post.author.username}`} className="post-author">
          <Avatar user={post.author} />
          <span><strong>{post.author.displayName}</strong><small>@{post.author.username} · {relativeTime(post.createdAt)}</small></span>
        </Link>
        <button className="icon-button" aria-label="Ещё о публикации" onClick={() => user && user.id !== post.author.id ? setReportOpen((open) => !open) : undefined}><MoreHorizontal /></button>
      </header>

      <div className={`post-image ${imageBroken ? "post-image--broken" : ""}`} onDoubleClick={doubleLike}>
        {!imageBroken ? <img src={post.imageUrl} alt={post.caption || `Публикация ${post.author.displayName}`} onError={() => setImageBroken(true)} /> : (
          <div className="broken-image"><Camera size={34} /><span>Не удалось загрузить фото.<br />Попробуй позже.</span></div>
        )}
        {heartBurst && <Heart className="heart-burst" fill="currentColor" />}
      </div>

      <div className="post-actions">
        <div>
          <button className={`action-button ${post.likedByMe ? "is-liked" : ""}`} onClick={() => void toggleLike()} aria-label={post.likedByMe ? "Убрать лайк" : "Поставить лайк"}>
            <Heart fill={post.likedByMe ? "currentColor" : "none"} /> <span>{formatCount(post.likesCount)}</span>
          </button>
          <Link className="action-button" to={`/p/${post.id}`} aria-label="Открыть комментарии"><MessageCircle /><span>{formatCount(post.commentsCount)}</span></Link>
          <button className="action-button" onClick={() => void sharePost()} aria-label="Поделиться"><Send /></button>
        </div>
        <button className={`action-button ${post.savedByMe ? "is-saved" : ""}`} onClick={() => void toggleSave()} aria-label={post.savedByMe ? "Убрать из сохранённого" : "Сохранить"}><Bookmark fill={post.savedByMe ? "currentColor" : "none"} /></button>
      </div>

      {reportOpen && <form className="report-form" onSubmit={submitReport}><div><Flag /><strong>Пожаловаться</strong></div><select value={reportCategory} onChange={(event) => setReportCategory(event.target.value)} aria-label="Причина жалобы"><option value="spam">Спам</option><option value="abuse">Травля или оскорбления</option><option value="nudity">Откровенный контент</option><option value="violence">Насилие</option><option value="copyright">Авторские права</option><option value="other">Другое</option></select><textarea value={reportDetails} onChange={(event) => setReportDetails(event.target.value)} maxLength={500} placeholder="Дополнительные детали (необязательно)" /><div><button type="button" className="button button--outline" onClick={() => setReportOpen(false)}>Отмена</button><button className="button button--dark" disabled={busy}><Flag /> Отправить</button></div></form>}

      <div className="post-copy">
        {post.caption && <p><Link to={`/u/${post.author.username}`}>@{post.author.username}</Link> {post.caption}</p>}
        {(post.comments ?? []).slice(detail ? 0 : -2).map((item) => (
          <p className="comment-line" key={item.id}><Link to={`/u/${item.author.username}`}>@{item.author.username}</Link> {item.text}</p>
        ))}
        {!detail && post.commentsCount > 2 && <Link className="all-comments" to={`/p/${post.id}`}>Показать все комментарии ({post.commentsCount})</Link>}
      </div>

      <form className="quick-comment" onSubmit={submitComment}>
        {user ? <Avatar user={user} size="small" /> : <span className="guest-avatar"><UserRound size={16} /></span>}
        <input value={comment} maxLength={300} onChange={(event) => setComment(event.target.value)} placeholder={user ? "Добавить комментарий..." : "Войди, чтобы ответить"} onFocus={() => !user && requireUser()} />
        <button type="submit" disabled={!comment.trim() || busy} aria-label="Отправить комментарий"><Send size={18} /></button>
      </form>
    </article>
  );
}

function AuthPage({ mode }: { mode: "login" | "register" }) {
  const isRegister = mode === "register";
  const { user, loading, setUser } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const notify = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [form, setForm] = useState({ email: "", username: "", displayName: "", login: "", password: "" });
  const [challenge, setChallenge] = useState<{ token: string; expiresAt: number } | null>(null);
  const [twoFactorCode, setTwoFactorCode] = useState("");
  const from = (location.state as { from?: string } | null)?.from ?? "/";

  useEffect(() => {
    if (!challenge) return;
    const remaining = challenge.expiresAt - Date.now();
    if (remaining <= 0) {
      setChallenge(null);
      setTwoFactorCode("");
      setError("Время подтверждения истекло. Введи пароль ещё раз.");
      return;
    }
    const timer = window.setTimeout(() => {
      setChallenge(null);
      setTwoFactorCode("");
      setError("Время подтверждения истекло. Введи пароль ещё раз.");
    }, remaining);
    return () => window.clearTimeout(timer);
  }, [challenge]);

  if (!loading && user) return <Navigate to={from} replace />;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (challenge) {
        const result = await api.verifyTwoFactorLogin(challenge.token, twoFactorCode);
        setUser(result.user);
        notify("Два шага пройдены. С возвращением!");
        navigate(from, { replace: true });
        return;
      }
      if (isRegister) {
        const result = await api.register({ email: form.email, username: form.username, displayName: form.displayName, password: form.password });
        setUser(result.user);
        notify(result.verificationSent ? "Аккаунт готов. Ссылка подтверждения уже на почте." : "Аккаунт готов. Теперь можно скидывать.");
      } else {
        const result = await api.login({ login: form.login, password: form.password });
        if ("requiresTwoFactor" in result && result.requiresTwoFactor) {
          setChallenge({ token: result.challengeToken, expiresAt: result.expiresAt });
          setTwoFactorCode("");
          setForm((current) => ({ ...current, password: "" }));
          return;
        }
        setUser(result.user);
        notify("С возвращением!");
      }
      navigate(from, { replace: true });
    } catch (submitError) {
      setError(getError(submitError));
      if (challenge && submitError instanceof ApiError && ["CHALLENGE_EXPIRED", "CHALLENGE_INVALID", "TOO_MANY_ATTEMPTS"].includes(submitError.code ?? "")) {
        setChallenge(null);
        setTwoFactorCode("");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-page">
      <Link to="/" className="auth-back"><ArrowLeft size={18} /> Назад в ленту</Link>
      <ThemeIconButton className="auth-theme-button" />
      <section className="auth-panel">
        <div className="auth-brand"><Brand /><span>скидывай как есть</span></div>
        <div className="auth-copy">
          <span className="eyebrow"><Sparkles size={14} /> фото без важного повода</span>
          <h1>{isRegister ? <>Это<br />XIVI</> : <>Снова<br />в XIVI</>}</h1>
          <p>{isRegister ? "Фото есть — уже достаточно." : "Тут всё примерно как было."}</p>
          <div className="auth-stickers" aria-hidden="true"><i>одно<br />фото</i><i>ещё<br />фото</i><i>ну и<br />ладно</i></div>
        </div>
      </section>
      <section className="auth-form-wrap">
        <form className="auth-form" onSubmit={submit}>
          <div>
            <span className="form-kicker">{challenge ? "Защищённый вход" : isRegister ? "Новый аккаунт" : "С возвращением"}</span>
            <h2>{challenge ? "Второй шаг" : isRegister ? "Создай аккаунт" : "Войти"}</h2>
            <p>{challenge ? "Код из приложения-аутентификатора или recovery code." : isRegister ? "Пара минут — и можно скидывать." : "Почта или ник. Всё."}</p>
          </div>
          {error && <div className="form-error" role="alert">{error}</div>}
          {challenge ? (
            <Field label="Код подтверждения" value={twoFactorCode} onChange={setTwoFactorCode} placeholder="000000" autoComplete="one-time-code" inputMode="text" maxLength={19} autoFocus />
          ) : isRegister ? (
            <>
              <Field label="Как тебя зовут" value={form.displayName} onChange={(value) => setForm({ ...form, displayName: value })} placeholder="Алексей" autoComplete="name" maxLength={50} />
              <Field label="Ник" prefix="@" value={form.username} onChange={(value) => setForm({ ...form, username: value.toLowerCase().replace(/[^a-z0-9_.]/g, "") })} placeholder="alex.jpg" autoComplete="username" maxLength={24} />
              <Field label="Почта" type="email" value={form.email} onChange={(value) => setForm({ ...form, email: value })} placeholder="you@example.ru" autoComplete="email" />
            </>
          ) : (
            <Field label="Почта или ник" value={form.login} onChange={(value) => setForm({ ...form, login: value })} placeholder="@lesha.jpg" autoComplete="username" />
          )}
          {!challenge && <Field label="Пароль" type="password" value={form.password} onChange={(value) => setForm({ ...form, password: value })} placeholder="Минимум 8 символов" autoComplete={isRegister ? "new-password" : "current-password"} minLength={8} />}
          <button className="button button--accent button--large" disabled={busy} type="submit">
            {busy && <LoaderCircle className="spin" size={19} />}{challenge ? "Подтвердить вход" : isRegister ? "Создать аккаунт" : "Войти в XIVI"}
          </button>
          {challenge ? <button className="demo-link" type="button" onClick={() => { setChallenge(null); setTwoFactorCode(""); setError(""); setForm((current) => ({ ...current, password: "" })); }}>Войти в другой аккаунт</button> : <p className="auth-switch">{isRegister ? "Уже есть аккаунт?" : "Нет аккаунта?"} <Link to={isRegister ? "/login" : "/register"}>{isRegister ? "Войти" : "Зарегистрироваться"}</Link></p>}
          {!isRegister && !challenge && <Link className="demo-link" to="/forgot-password">Забыл пароль</Link>}
          {import.meta.env.DEV && !isRegister && !challenge && <button className="demo-link" type="button" onClick={() => setForm({ ...form, login: "kotleta.jpg", password: "demo12345" })}>Заполнить демо-вход</button>}
        </form>
      </section>
    </main>
  );
}

function PasswordHelpPage({ mode }: { mode: "forgot" | "reset" }) {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { setUser } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const token = params.get("token") ?? "";

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError("");
    try {
      if (mode === "forgot") {
        await api.forgotPassword(email);
        setDone(true);
      } else {
        if (!token) throw new Error("В ссылке нет токена сброса.");
        const result = await api.resetPassword(token, password);
        setUser(result.user);
        navigate("/", { replace: true });
      }
    } catch (submitError) { setError(getError(submitError)); }
    finally { setBusy(false); }
  }

  return <main className="auth-simple"><Brand /><ThemeIconButton className="auth-theme-button" /><form className="auth-form auth-form--card" onSubmit={submit}><Link to="/login" className="text-link"><ArrowLeft size={16} /> Назад ко входу</Link><div><span className="form-kicker">Безопасность XIVI</span><h2>{mode === "forgot" ? "Восстановить пароль" : "Новый пароль"}</h2><p>{mode === "forgot" ? "Пришлём ссылку на почту, если аккаунт существует." : "Задай новый пароль для аккаунта."}</p></div>{error && <div className="form-error" role="alert">{error}</div>}{done ? <div className="success-panel"><MailCheck /><strong>Проверь почту</strong><p>Ссылка действует 30 минут.</p></div> : <>{mode === "forgot" ? <Field label="Почта" type="email" value={email} onChange={setEmail} autoComplete="email" placeholder="you@example.com" /> : <Field label="Новый пароль" type="password" value={password} onChange={setPassword} autoComplete="new-password" minLength={8} placeholder="Минимум 8 символов" />}<button className="button button--accent button--large" disabled={busy}>{busy && <LoaderCircle className="spin" />}{mode === "forgot" ? "Отправить ссылку" : "Сохранить пароль"}</button></>}</form></main>;
}

function VerifyEmailPage() {
  const [params] = useSearchParams();
  const { setUser } = useAuth();
  const started = useRef(false);
  const [state, setState] = useState<"loading" | "done" | "error">("loading");
  const [message, setMessage] = useState("");

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const token = params.get("token") ?? "";
    if (!token) { setState("error"); setMessage("В ссылке нет токена подтверждения."); return; }
    void api.verifyEmail(token).then((result) => { setUser(result.user); setState("done"); }).catch((error) => { setState("error"); setMessage(getError(error)); });
  }, [params, setUser]);

  return <main className="auth-simple"><Brand /><section className="state-card state-card--standalone">{state === "loading" ? <><LoaderCircle className="spin" size={38} /><h1>Подтверждаем почту</h1></> : state === "done" ? <><BadgeCheck className="success-icon" size={46} /><h1>Почта подтверждена</h1><p>Теперь восстановление доступа и уведомления работают полностью.</p><Link className="button button--accent" to="/">В XIVI</Link></> : <><ShieldAlert size={46} /><h1>Ссылка не сработала</h1><p>{message}</p><Link className="button button--dark" to="/settings/profile">В настройки</Link></>}</section></main>;
}

function Field({ label, prefix, value, onChange, ...inputProps }: { label: string; prefix?: string; value: string; onChange: (value: string) => void } & Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange">) {
  return (
    <label className="field">
      <span>{label}</span>
      <div className="field-input">{prefix && <i>{prefix}</i>}<input required value={value} onChange={(event) => onChange(event.target.value)} {...inputProps} /></div>
    </label>
  );
}

function SearchPage() {
  const [query, setQuery] = useState("");
  const [users, setUsers] = useState<User[]>([]);
  const [posts, setPosts] = useState<Post[]>([]);
  const [searched, setSearched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function search(event: FormEvent) {
    event.preventDefault();
    const normalized = query.trim();
    if (!normalized || busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await api.search(normalized);
      setUsers(result.users);
      setPosts(result.posts);
      setSearched(true);
    } catch (searchError) {
      setError(getError(searchError));
    } finally {
      setBusy(false);
    }
  }

  function updatePost(updated: Post) {
    setPosts((current) => current.map((post) => post.id === updated.id ? updated : post));
  }

  return (
    <div className="discovery-page page-width page-width--narrow">
      <div className="page-heading"><span className="eyebrow"><Search size={14} /> глобальный поиск</span><h1>Найди людей<br />и кадры</h1><p>Ищем по нику, имени, био и подписям.</p></div>
      <form className="search-box" onSubmit={search} role="search">
        <Search aria-hidden="true" />
        <input value={query} onChange={(event) => setQuery(event.target.value)} maxLength={100} placeholder="Например: море или @kotleta.jpg" aria-label="Поисковый запрос" autoFocus />
        <button className="button button--dark" disabled={!query.trim() || busy}>{busy && <LoaderCircle className="spin" />} Найти</button>
      </form>
      {error && <div className="form-error" role="alert">{error}</div>}
      {searched && !users.length && !posts.length && <div className="state-card"><span className="state-emoji">⌕</span><h2>Ничего не найдено</h2><p>Попробуй короче или без @.</p></div>}
      {users.length > 0 && <section className="search-section"><div className="section-title"><span>Люди</span><small>{users.length}</small></div><div className="search-users">{users.map((user) => <Suggestion user={user} key={user.id} />)}</div></section>}
      {posts.length > 0 && <section className="search-section"><div className="section-title"><span>Публикации</span><small>{posts.length}</small></div><div className="post-list">{posts.map((post) => <PostCard key={post.id} post={post} onChange={updatePost} />)}</div></section>}
    </div>
  );
}

function SavedPage() {
  const [posts, setPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [page, setPage] = useState(1);
  const [error, setError] = useState("");

  const load = useCallback(async (nextPage = 1, append = false) => {
    append ? setLoadingMore(true) : setLoading(true);
    setError("");
    try {
      const result = await api.saved(nextPage);
      setPosts((current) => append ? [...current, ...result.posts] : result.posts);
      setHasMore(result.hasMore);
      setPage(nextPage);
    } catch (loadError) {
      setError(getError(loadError));
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  function updatePost(updated: Post) {
    if (updated.savedByMe) {
      setPosts((current) => current.map((post) => post.id === updated.id ? updated : post));
      return;
    }
    setPosts((current) => current.filter((post) => post.id !== updated.id));
    // OFFSET pagination shifts after a removal; restart from page one so nothing is skipped.
    void load(1, false);
  }

  return (
    <div className="saved-page page-width page-width--narrow">
      <div className="page-heading"><span className="eyebrow"><BookmarkCheck size={14} /> только для тебя</span><h1>Сохранённое</h1><p>Приватная коллекция кадров, к которым хочется вернуться.</p></div>
      {loading ? <FeedSkeleton /> : error ? <ErrorState message={error} onRetry={() => void load()} /> : posts.length ? <div className="post-list">{posts.map((post) => <PostCard key={post.id} post={post} onChange={updatePost} />)}{hasMore && <button className="button button--outline load-more" disabled={loadingMore} onClick={() => void load(page + 1, true)}>{loadingMore && <LoaderCircle className="spin" />} Показать ещё</button>}</div> : <div className="state-card"><Bookmark size={38} /><h2>Коллекция пуста</h2><p>Нажми закладку под любым постом — он появится здесь.</p><Link className="button button--accent" to="/">В ленту</Link></div>}
    </div>
  );
}

function NotificationsPage() {
  const [items, setItems] = useState<XiviNotification[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [page, setPage] = useState(1);
  const [error, setError] = useState("");

  const load = useCallback(async (nextPage = 1, append = false) => {
    append ? setLoadingMore(true) : setLoading(true);
    setError("");
    try {
      const result = await api.notifications(nextPage);
      setItems((current) => append ? [...current, ...result.notifications] : result.notifications);
      setHasMore(result.hasMore);
      setPage(nextPage);
      append ? setLoadingMore(false) : setLoading(false);
      const unreadIds = result.notifications.filter((item) => !item.isRead).map((item) => item.id);
      if (unreadIds.length) {
        try {
          await api.markNotificationsRead(unreadIds);
          const readIds = new Set(unreadIds);
          setItems((current) => current.map((item) => readIds.has(item.id) ? { ...item, isRead: true } : item));
          const remaining = await api.unreadNotifications();
          window.dispatchEvent(new CustomEvent("xivi:notifications-read", { detail: remaining.count }));
        } catch {
          // The list is still useful; unread state can be retried on the next visit.
        }
      }
    } catch (loadError) {
      setError(getError(loadError));
      setLoading(false);
      setLoadingMore(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  return (
    <div className="notifications-page page-width page-width--narrow">
      <div className="page-heading"><span className="eyebrow"><Bell size={14} /> активность</span><h1>Уведомления</h1><p>Лайки, комментарии и новые подписчики — без лишнего шума.</p></div>
      {loading ? <PageLoader /> : error ? <ErrorState message={error} onRetry={() => void load()} /> : items.length ? <><div className="notification-list">{items.map((item) => <NotificationRow item={item} key={item.id} />)}</div>{hasMore && <button className="button button--outline notification-more" disabled={loadingMore} onClick={() => void load(page + 1, true)}>{loadingMore && <LoaderCircle className="spin" />} Показать более ранние</button>}</> : <div className="state-card"><Bell size={38} /><h2>Пока тихо</h2><p>Когда кто-то отреагирует на твой контент, это появится здесь.</p></div>}
    </div>
  );
}

function NotificationRow({ item }: { item: XiviNotification }) {
  const copy = item.type === "like" ? "лайкнул(а) твоё фото" : item.type === "comment" ? "оставил(а) комментарий" : item.type === "follow" ? "подписался(-ась) на тебя" : item.type === "message" ? "написал(а) тебе" : "проявил(а) активность";
  const target = item.type === "message" ? "/messages" : item.postId ? `/p/${item.postId}` : `/u/${item.actor.username}`;
  return (
    <Link to={target} className={`notification-row ${item.isRead ? "" : "is-unread"}`}>
      <Avatar user={item.actor} size="medium" />
      <span className="notification-copy"><strong>{item.actor.displayName}</strong> {copy}<small>{relativeTime(item.createdAt)}</small></span>
      {item.post?.imageUrl ? <img className="notification-thumb" src={item.post.imageUrl} alt="" /> : <ChevronRight />}
    </Link>
  );
}

function ProfilePage() {
  const { username = "" } = useParams();
  const { user: currentUser } = useAuth();
  const navigate = useNavigate();
  const notify = useToast();
  const [profile, setProfile] = useState<User | null>(null);
  const [posts, setPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const loadProfile = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const result = await api.profile(username);
      setProfile(result.user);
      setPosts(result.posts);
    } catch (loadError) {
      setError(getError(loadError));
    } finally {
      setLoading(false);
    }
  }, [username]);

  useEffect(() => { void loadProfile(); }, [loadProfile]);

  async function toggleFollow() {
    if (!currentUser) {
      navigate("/login", { state: { from: `/u/${username}` } });
      return;
    }
    if (!profile || busy) return;
    setBusy(true);
    try {
      const result = await api.follow(profile.username);
      setProfile({ ...profile, isFollowing: result.following, followersCount: result.followersCount });
    } catch (followError) {
      notify(getError(followError), "bad");
    } finally {
      setBusy(false);
    }
  }

  async function startChat() {
    if (!currentUser) {
      navigate("/login", { state: { from: `/u/${username}` } });
      return;
    }
    if (!profile || busy) return;
    setBusy(true);
    try {
      const result = await api.startConversation(profile.username);
      navigate(`/messages/${result.conversation.id}`);
    } catch (chatError) {
      notify(getError(chatError), "bad");
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <PageLoader />;
  if (error || !profile) return <ErrorState message={error || "Профиль не найден."} onRetry={() => void loadProfile()} />;
  const isMe = currentUser?.username === profile.username || profile.isMe;

  return (
    <div className="profile-page page-width">
      <section className="profile-hero">
        <div className="profile-avatar-wrap"><Avatar user={profile} size="hero" /><span className="profile-stamp">профиль</span></div>
        <div className="profile-info">
          <div className="profile-title-row">
            <div><span className="profile-handle">@{profile.username}</span><h1>{profile.displayName}</h1></div>
            {isMe ? <Link className="button button--outline" to="/settings/profile"><Settings size={18} /> Редактировать</Link> : <div className="profile-actions"><button className={`button ${profile.isFollowing ? "button--outline" : "button--dark"}`} disabled={busy} onClick={() => void toggleFollow()}>{profile.isFollowing ? "Ты подписан" : "Подписаться"}</button><button className="button button--outline" disabled={busy} onClick={() => void startChat()}><MessagesSquare size={17} /> Написать</button></div>}
          </div>
          <p className="profile-bio">{profile.bio || "Без описания."}</p>
          <div className="profile-stats">
            <div><strong>{profile.postsCount ?? posts.length}</strong><span>публикаций</span></div>
            <div><strong>{formatCount(profile.followersCount ?? 0)}</strong><span>подписчиков</span></div>
            <div><strong>{formatCount(profile.followingCount ?? 0)}</strong><span>подписок</span></div>
          </div>
        </div>
      </section>
      <div className="profile-divider"><span>Публикации</span><i /></div>
      {posts.length ? (
        <div className="profile-grid">
          {posts.map((post) => (
            <Link to={`/p/${post.id}`} className="grid-post" key={post.id}>
              <img src={post.imageUrl} alt={post.caption || `Публикация ${profile.displayName}`} />
              <span><Heart size={18} fill="currentColor" /> {post.likesCount} <MessageCircle size={18} fill="currentColor" /> {post.commentsCount}</span>
            </Link>
          ))}
        </div>
      ) : <div className="empty-profile"><Camera size={36} /><h2>Публикаций пока нет</h2><p>{isMe ? "Добавь первый кадр." : "Здесь пока ничего нет."}</p>{isMe && <Link className="button button--accent" to="/create">Создать публикацию</Link>}</div>}
    </div>
  );
}

function CreatePage() {
  const navigate = useNavigate();
  const notify = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState("");
  const [caption, setCaption] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!file) { setPreview(""); return; }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  function chooseFile(nextFile?: File) {
    if (!nextFile) return;
    if (!nextFile.type.match(/^image\/(jpeg|png|webp)$/)) {
      notify("Подойдёт JPG, PNG или WebP.", "bad");
      return;
    }
    if (nextFile.size > 10 * 1024 * 1024) {
      notify("Файл больше 10 МБ. Выбери фото поменьше.", "bad");
      return;
    }
    setFile(nextFile);
  }

  async function publish() {
    if (!file || busy) return;
    setBusy(true);
    try {
      const result = await api.createPost(file, caption.trim());
      notify("Публикация уже в ленте.");
      navigate(`/p/${result.post.id}`);
    } catch (error) {
      notify(getError(error), "bad");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="create-page page-width page-width--narrow">
      <div className="page-heading"><span className="eyebrow"><Camera size={14} /> новый фид</span><h1>Скинь фото<br />как есть</h1><p>Подпись необязательна. Как и повод.</p></div>
      <section className="composer">
        <div className={`upload-zone ${preview ? "has-preview" : ""}`} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); chooseFile(event.dataTransfer.files[0]); }}>
          {preview ? <><img src={preview} alt="Предпросмотр публикации" /><button className="remove-preview" onClick={() => setFile(null)} aria-label="Убрать фото"><X /></button></> : (
            <button onClick={() => inputRef.current?.click()}>
              <span className="upload-icon"><ImagePlus /></span><strong>Перетащи фото сюда</strong><small>или нажми, чтобы выбрать</small><em>JPG, PNG, WebP · до 10 МБ</em>
            </button>
          )}
          <input ref={inputRef} hidden type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => chooseFile(event.target.files?.[0])} />
        </div>
        <div className="caption-side">
          <label><span>Что происходит?</span><textarea value={caption} maxLength={500} onChange={(event) => setCaption(event.target.value)} placeholder="Например: этот день стоит запомнить." /><small>{caption.length}/500</small></label>
          <div className="publish-note"><Sparkles size={20} /><p><strong>Подсказка</strong>Короткая подпись работает лучше.</p></div>
          <button className="button button--accent button--large" disabled={!file || busy} onClick={() => void publish()}>{busy ? <LoaderCircle className="spin" /> : <Upload />} Опубликовать</button>
        </div>
      </section>
    </div>
  );
}

function PostPage() {
  const id = Number(useParams().postId);
  const notify = useToast();
  const navigate = useNavigate();
  const [post, setPost] = useState<Post | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    if (!Number.isFinite(id)) { setError("Ссылка на публикацию выглядит странно."); setLoading(false); return; }
    setLoading(true);
    try {
      const result = await api.post(id);
      setPost(result.post);
    } catch (loadError) {
      setError(getError(loadError));
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { void load(); }, [load]);

  async function removePost() {
    if (!post || !window.confirm("Удалить публикацию? Это действие нельзя отменить.")) return;
    try {
      await api.deletePost(post.id);
      notify("Публикация удалена.");
      navigate(`/u/${post.author.username}`);
    } catch (removeError) {
      notify(getError(removeError), "bad");
    }
  }

  if (loading) return <PageLoader />;
  if (error || !post) return <ErrorState message={error || "Публикация не найдена."} onRetry={() => void load()} />;

  return (
    <div className="post-detail-page page-width page-width--narrow">
      <div className="detail-toolbar"><button onClick={() => navigate(-1)}><ArrowLeft /> Назад</button>{post.canDelete && <button className="danger-link" onClick={() => void removePost()}><Trash2 /> Удалить</button>}</div>
      <PostCard post={post} onChange={setPost} detail />
    </div>
  );
}

function MessagesPage() {
  const params = useParams();
  const navigate = useNavigate();
  const notify = useToast();
  const activeId = Number(params.conversationId ?? 0);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const messageListRef = useRef<HTMLDivElement>(null);

  const loadConversations = useCallback(async () => {
    const result = await api.conversations();
    setConversations(result.conversations);
    window.dispatchEvent(new CustomEvent("xivi:messages-read", { detail: result.unreadTotal }));
    return result;
  }, []);

  const loadMessages = useCallback(async (conversationId: number, before?: number, quiet = false) => {
    if (!quiet) before ? setLoadingOlder(true) : setLoadingMessages(true);
    try {
      const result = await api.messages(conversationId, before);
      setHasMore(result.hasMore);
      setMessages((current) => before ? [...result.messages, ...current] : result.messages);
      await api.markConversationRead(conversationId);
      await loadConversations();
    } finally {
      if (!quiet) { setLoadingMessages(false); setLoadingOlder(false); }
    }
  }, [loadConversations]);

  const bootstrap = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const result = await loadConversations();
      if (!activeId && result.conversations.length) {
        navigate(`/messages/${result.conversations[0].id}`, { replace: true });
      }
    } catch (loadError) { setError(getError(loadError)); }
    finally { setLoading(false); }
  }, [activeId, loadConversations, navigate]);

  useEffect(() => { void bootstrap(); }, [bootstrap]);
  useEffect(() => {
    if (!activeId) { setMessages([]); setHasMore(false); return; }
    setMessages([]); setError("");
    void loadMessages(activeId).catch((loadError) => setError(getError(loadError)));
  }, [activeId, loadMessages]);
  useEffect(() => {
    if (!activeId) return;
    const timer = window.setInterval(() => {
      void loadMessages(activeId, undefined, true).catch(() => undefined);
    }, 5000);
    return () => window.clearInterval(timer);
  }, [activeId, loadMessages]);
  useEffect(() => {
    if (!loadingOlder) messageListRef.current?.scrollTo({ top: messageListRef.current.scrollHeight, behavior: "smooth" });
  }, [messages.length, loadingOlder]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const text = draft.trim();
    if (!activeId || !text || sending) return;
    setSending(true);
    try {
      const result = await api.sendMessage(activeId, text);
      setMessages((current) => [...current, result.message]);
      setDraft("");
      await loadConversations();
    } catch (sendError) { notify(getError(sendError), "bad"); }
    finally { setSending(false); }
  }

  const active = conversations.find((conversation) => conversation.id === activeId);
  if (loading) return <PageLoader />;
  if (error && !conversations.length) return <ErrorState message={error} onRetry={() => void bootstrap()} />;

  return (
    <div className="messages-page page-width">
      <div className="page-heading"><span className="eyebrow"><MessagesSquare size={14} /> личные сообщения</span><h1>Диалоги</h1><p>Переписка один на один. Текст зашифрован в базе AES-256-GCM и передаётся по HTTPS.</p></div>
      <section className="messenger-shell">
        <aside className={`conversation-list ${active ? "has-active" : ""}`} aria-label="Диалоги">
          <div className="conversation-list-head"><strong>Сообщения</strong><small>{conversations.length}</small></div>
          {conversations.length ? conversations.map((conversation) => (
            <NavLink to={`/messages/${conversation.id}`} className={({ isActive }) => `conversation-item ${isActive ? "is-active" : ""}`} key={conversation.id}>
              <Avatar user={conversation.otherUser} size="medium" />
              <span><strong>{conversation.otherUser.displayName}</strong><small>{conversation.lastMessageMine ? "Ты: " : ""}{conversation.lastMessage}</small></span>
              <i>{conversation.unreadCount > 0 ? <b>{Math.min(99, conversation.unreadCount)}</b> : conversation.lastMessageAt ? relativeTime(conversation.lastMessageAt) : ""}</i>
            </NavLink>
          )) : <div className="conversation-empty"><MessagesSquare /><strong>Пока без диалогов</strong><p>Открой профиль человека и нажми «Написать».</p><Link to="/search" className="button button--outline">Найти людей</Link></div>}
        </aside>
        <div className={`chat-panel ${active ? "is-active" : ""}`}>
          {active ? <>
            <header className="chat-head"><button className="icon-button chat-back" onClick={() => navigate("/messages")} aria-label="К списку диалогов"><ArrowLeft /></button><Link to={`/u/${active.otherUser.username}`}><Avatar user={active.otherUser} size="medium" /><span><strong>{active.otherUser.displayName}</strong><small>@{active.otherUser.username}</small></span></Link><div className="encryption-note" title="Шифрование хранения, не end-to-end"><LockKeyhole /><span>AES-GCM</span></div></header>
            <div className="message-list" ref={messageListRef}>
              {hasMore && <button className="button button--outline message-older" disabled={loadingOlder} onClick={() => void loadMessages(active.id, messages[0]?.id).catch((loadError) => setError(getError(loadError)))}>{loadingOlder && <LoaderCircle className="spin" />} Более ранние</button>}
              {loadingMessages ? <div className="inline-loader"><LoaderCircle className="spin" /> Загружаем сообщения...</div> : messages.length ? messages.map((message) => <div className={`message-row ${message.mine ? "is-mine" : ""}`} key={message.id}><div className="message-bubble"><p>{message.body}</p><small>{new Intl.DateTimeFormat("ru", { hour: "2-digit", minute: "2-digit" }).format(new Date(message.createdAt))}</small></div></div>) : <div className="chat-empty"><Sparkles /><strong>Начало диалога</strong><p>Напиши что-нибудь человеческое.</p></div>}
            </div>
            <form className="message-composer" onSubmit={submit}><textarea value={draft} onChange={(event) => setDraft(event.target.value)} maxLength={2000} rows={1} placeholder="Сообщение..." onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} /><button className="button button--accent" disabled={!draft.trim() || sending} aria-label="Отправить сообщение">{sending ? <LoaderCircle className="spin" /> : <Send />}</button></form>
          </> : <div className="chat-placeholder"><MessagesSquare /><h2>Выбери диалог</h2><p>Или начни новый из профиля пользователя.</p></div>}
        </div>
      </section>
    </div>
  );
}

function AdminPage() {
  const notify = useToast();
  const [summary, setSummary] = useState<ModerationSummary | null>(null);
  const [reports, setReports] = useState<PostReport[]>([]);
  const [users, setUsers] = useState<ModerationUser[]>([]);
  const [tab, setTab] = useState<"reports" | "users">("reports");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async (userQuery = "") => {
    setLoading(true); setError("");
    try {
      const [nextSummary, nextReports, nextUsers] = await Promise.all([api.adminSummary(), api.adminReports("open"), api.adminUsers(userQuery)]);
      setSummary(nextSummary); setReports(nextReports.reports); setUsers(nextUsers.users);
    } catch (loadError) { setError(getError(loadError)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function resolve(report: PostReport, status: "resolved" | "dismissed") {
    setBusyId(`report-${report.id}`);
    try { await api.resolveReport(report.id, status); notify(status === "resolved" ? "Жалоба закрыта." : "Жалоба отклонена."); await load(query); }
    catch (actionError) { notify(getError(actionError), "bad"); }
    finally { setBusyId(""); }
  }

  async function removeReportedPost(report: PostReport) {
    const reason = window.prompt("Причина удаления публикации:", report.details || categoryName(report.category));
    if (reason === null || !reason.trim()) return;
    setBusyId(`report-${report.id}`);
    try { await api.adminDeletePost(report.post.id, reason.trim()); notify("Публикация удалена модератором."); await load(query); }
    catch (actionError) { notify(getError(actionError), "bad"); }
    finally { setBusyId(""); }
  }

  async function toggleBan(target: ModerationUser) {
    setBusyId(`user-${target.id}`);
    try {
      if (target.isBanned) {
        await api.unbanUser(target.id);
        notify(`@${target.username} разблокирован.`);
      } else {
        const reason = window.prompt("Причина блокировки:", target.reportsCount ? "Нарушение правил сообщества" : "");
        if (reason === null || !reason.trim()) return;
        const daysText = window.prompt("На сколько дней? 0 — бессрочно.", "7");
        if (daysText === null) return;
        const days = Math.max(0, Math.min(3650, Number(daysText) || 0));
        await api.banUser(target.id, reason.trim(), days);
        notify(`@${target.username} заблокирован.`);
      }
      await load(query);
    } catch (actionError) { notify(getError(actionError), "bad"); }
    finally { setBusyId(""); }
  }

  return (
    <div className="admin-page page-width">
      <div className="page-heading"><span className="eyebrow"><Shield size={14} /> только для админов</span><h1>Модерация</h1><p>Жалобы, блокировки и удаление нарушающего контента с журналом действий.</p></div>
      {summary && <div className="admin-summary"><article><Flag /><span><strong>{summary.openReports}</strong><small>открытых жалоб</small></span></article><article><Ban /><span><strong>{summary.bannedUsers}</strong><small>заблокировано</small></span></article><article><UserRound /><span><strong>{summary.totalUsers}</strong><small>пользователей</small></span></article></div>}
      <div className="admin-tabs"><button className={tab === "reports" ? "is-active" : ""} onClick={() => setTab("reports")}><Flag /> Жалобы</button><button className={tab === "users" ? "is-active" : ""} onClick={() => setTab("users")}><UserRound /> Пользователи</button></div>
      {error ? <ErrorState message={error} onRetry={() => void load(query)} /> : loading ? <PageLoader /> : tab === "reports" ? reports.length ? <div className="admin-list">{reports.map((report) => <article className="report-card" key={report.id}><Link className="report-preview" to={`/p/${report.post.id}`}><img src={report.post.imageUrl} alt="Публикация из жалобы" /></Link><div className="report-copy"><div className="report-meta"><span className="status-pill">{categoryName(report.category)}</span><small>{relativeTime(report.createdAt)}</small></div><h3>@{report.post.author.username}</h3><p>{report.details || "Пользователь не добавил пояснение."}</p><small>Сообщил(а): <Link to={`/u/${report.reporter.username}`}>@{report.reporter.username}</Link></small><div className="admin-actions"><button className="button danger-button" disabled={busyId === `report-${report.id}`} onClick={() => void removeReportedPost(report)}><Trash2 /> Удалить пост</button><button className="button button--outline" disabled={busyId === `report-${report.id}`} onClick={() => void resolve(report, "dismissed")}>Отклонить</button><button className="button button--dark" disabled={busyId === `report-${report.id}`} onClick={() => void resolve(report, "resolved")}><Check /> Закрыть</button></div></div></article>)}</div> : <div className="state-card"><ShieldCheck size={38} /><h2>Очередь чиста</h2><p>Открытых жалоб сейчас нет.</p></div> : <><form className="admin-search" onSubmit={(event) => { event.preventDefault(); void load(query); }}><Search /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Ник, имя или email" /><button className="button button--dark">Найти</button></form><div className="admin-list">{users.map((target) => <article className={`moderation-user ${target.isBanned ? "is-banned" : ""}`} key={target.id}><Avatar user={target} size="medium" /><div><strong>{target.displayName} <small>@{target.username}</small></strong><span>{target.email}</span><span>{target.postsCount} постов · {target.reportsCount} открытых жалоб{target.isBanned ? ` · бан: ${target.bannedReason}` : ""}</span></div>{target.role === "admin" ? <span className="status-pill"><Shield /> Админ</span> : <button className={`button ${target.isBanned ? "button--outline" : "danger-button"}`} disabled={busyId === `user-${target.id}`} onClick={() => void toggleBan(target)}>{target.isBanned ? <><Check /> Разбанить</> : <><Ban /> Заблокировать</>}</button>}</article>)}</div></>}
    </div>
  );
}

function SettingsPage() {
  const { user, setUser } = useAuth();
  const notify = useToast();
  const [displayName, setDisplayName] = useState(user?.displayName ?? "");
  const [bio, setBio] = useState(user?.bio ?? "");
  const [busy, setBusy] = useState(false);

  if (!user) return null;

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const result = await api.updateProfile({ displayName, bio });
      setUser(result.user);
      notify("Профиль обновлён.");
    } catch (error) { notify(getError(error), "bad"); }
    finally { setBusy(false); }
  }

  async function uploadAvatar(file?: File) {
    if (!file) return;
    setBusy(true);
    try {
      const result = await api.updateAvatar(file);
      setUser(result.user);
      notify("Аватар обновлён.");
    } catch (error) { notify(getError(error), "bad"); }
    finally { setBusy(false); }
  }

  return (
    <div className="settings-page page-width page-width--narrow">
      <div className="page-heading"><span className="eyebrow"><Settings size={14} /> центр управления</span><h1>Настройки</h1><p>Профиль, внешний вид и безопасность аккаунта.</p></div>
      <div className="settings-stack">
        <form className="settings-card" onSubmit={save}>
          <SettingsSectionTitle title="Профиль" description="Имя, фото и короткое описание." />
          <div className="avatar-editor"><Avatar user={user} size="large" /><div><strong>@{user.username}</strong><label className="button button--outline" tabIndex={0} role="button" onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.currentTarget.querySelector("input")?.click(); } }}><Camera size={17} /> Сменить фото<input hidden type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => void uploadAvatar(event.target.files?.[0])} /></label></div></div>
          <Field label="Имя" value={displayName} maxLength={50} onChange={setDisplayName} />
          <label className="field"><span>О себе</span><textarea value={bio} maxLength={160} onChange={(event) => setBio(event.target.value)} placeholder="Пара слов, которые всё объяснят" /><small>{bio.length}/160</small></label>
          <button className="button button--dark button--large" disabled={busy}>{busy && <LoaderCircle className="spin" />} Сохранить изменения</button>
        </form>
        <section className="settings-card">
          <SettingsSectionTitle title="Внешний вид" description="Выбор сохраняется на этом устройстве." />
          <ThemeSwitcher />
        </section>
        <EmailVerificationCard />
        <TwoFactorSettings />
      </div>
    </div>
  );
}

function EmailVerificationCard() {
  const { user } = useAuth();
  const notify = useToast();
  const [busy, setBusy] = useState(false);
  if (!user) return null;
  async function send() {
    setBusy(true);
    try {
      const result = await api.sendVerificationEmail();
      if (!result.configured) notify("Почтовая отправка пока не настроена.", "bad");
      else if (result.sent) notify("Ссылка подтверждения отправлена на почту.");
      else notify("Письмо не отправилось. Попробуй чуть позже.", "bad");
    } catch (error) { notify(getError(error), "bad"); }
    finally { setBusy(false); }
  }
  return <section className="settings-card email-status-card"><SettingsSectionTitle title="Почта и восстановление" description="Подтверждённая почта помогает безопасно вернуть доступ." /><div className={`email-status ${user.emailVerified ? "is-verified" : ""}`}><span>{user.emailVerified ? <BadgeCheck /> : <MailCheck />}</span><div><strong>{user.emailVerified ? "Почта подтверждена" : "Подтверди почту"}</strong><small>{user.emailVerified ? "Восстановление доступа доступно." : "Отправим одноразовую ссылку на адрес аккаунта."}</small></div>{!user.emailVerified && <button className="button button--outline" disabled={busy} onClick={() => void send()}>{busy ? <LoaderCircle className="spin" /> : <Send />} Отправить ссылку</button>}</div></section>;
}

function SettingsSectionTitle({ title, description }: { title: string; description: string }) {
  return <div className="settings-section-title"><div><strong>{title}</strong><p>{description}</p></div></div>;
}

function ThemeSwitcher() {
  const { theme, setTheme } = useTheme();
  const modes: Array<{ value: ThemeMode; label: string; icon: ReactNode }> = [
    { value: "light", label: "Светлая", icon: <Sun /> },
    { value: "dark", label: "Тёмная", icon: <Moon /> },
    { value: "system", label: "Системная", icon: <Monitor /> },
  ];
  return <div className="theme-switcher" role="group" aria-label="Цветовая тема">{modes.map((mode) => <button type="button" aria-pressed={theme === mode.value} className={`theme-option ${theme === mode.value ? "is-active" : ""}`} onClick={() => setTheme(mode.value)} key={mode.value}>{mode.icon}{mode.label}</button>)}</div>;
}

function TwoFactorSettings() {
  const notify = useToast();
  const [status, setStatus] = useState<TwoFactorStatus | null>(null);
  const [setup, setSetup] = useState<TwoFactorSetup | null>(null);
  const [qrCodeUrl, setQrCodeUrl] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refreshStatus = useCallback(async () => {
    try { setStatus(await api.twoFactorStatus()); }
    catch (loadError) { setError(getError(loadError)); }
  }, []);

  useEffect(() => { void refreshStatus(); }, [refreshStatus]);
  useEffect(() => {
    if (!setup) { setQrCodeUrl(""); return; }
    void QRCode.toDataURL(setup.otpauthUri, { width: 224, margin: 1, color: { dark: "#171717", light: "#ffffff" } })
      .then(setQrCodeUrl)
      .catch(() => setError("QR-код не собрался. Скопируй секрет вручную."));
  }, [setup]);
  useEffect(() => {
    if (!setup) return;
    const remaining = setup.expiresAt - Date.now();
    if (remaining <= 0) {
      setSetup(null);
      setCode("");
      setError("QR-настройка истекла. Начни ещё раз.");
      return;
    }
    const timer = window.setTimeout(() => {
      setSetup(null);
      setCode("");
      setError("QR-настройка истекла. Начни ещё раз.");
    }, remaining);
    return () => window.clearTimeout(timer);
  }, [setup]);

  async function startSetup() {
    if (!password || busy) return;
    setBusy(true); setError("");
    try {
      setSetup(await api.beginTwoFactorSetup(password));
      setPassword("");
      setCode(""); setRecoveryCodes([]);
    } catch (setupError) { setError(getError(setupError)); }
    finally { setBusy(false); }
  }

  async function enable() {
    if (!code || busy) return;
    setBusy(true); setError("");
    try {
      const result = await api.enableTwoFactor(code);
      setRecoveryCodes(result.recoveryCodes);
      setStatus({ enabled: true, setupPending: false, recoveryCodesRemaining: result.recoveryCodes.length });
      setSetup(null); setPassword(""); setCode("");
      notify("Двухфакторка включена.");
    } catch (enableError) { setError(getError(enableError)); }
    finally { setBusy(false); }
  }

  async function disable() {
    if (!password || !code || busy || !window.confirm("Отключить двухфакторную защиту?")) return;
    setBusy(true); setError("");
    try {
      await api.disableTwoFactor(password, code);
      setStatus({ enabled: false, setupPending: false, recoveryCodesRemaining: 0 });
      setPassword(""); setCode(""); setRecoveryCodes([]);
      notify("Двухфакторка отключена.");
    } catch (disableError) { setError(getError(disableError)); }
    finally { setBusy(false); }
  }

  async function regenerate() {
    if (!code || busy) return;
    setBusy(true); setError("");
    try {
      const result = await api.regenerateRecoveryCodes(code);
      setRecoveryCodes(result.recoveryCodes);
      setStatus((current) => current ? { ...current, recoveryCodesRemaining: result.recoveryCodes.length } : current);
      setCode("");
      notify("Новые recovery codes готовы. Старые больше не работают.");
    } catch (regenerateError) { setError(getError(regenerateError)); }
    finally { setBusy(false); }
  }

  async function copyRecoveryCodes() {
    try {
      await navigator.clipboard.writeText(recoveryCodes.join("\n"));
      notify("Recovery codes скопированы.");
    } catch { notify("Не удалось скопировать. Выдели коды вручную.", "bad"); }
  }

  return (
    <section className="settings-card security-card">
      <SettingsSectionTitle title="Двухфакторная защита" description="TOTP-коды из любого приложения-аутентификатора." />
      {!status ? error ? <div className="status-error"><div className="form-error" role="alert">{error}</div><button type="button" className="button button--outline" onClick={() => { setError(""); void refreshStatus(); }}>Повторить</button></div> : <div className="inline-loader"><LoaderCircle className="spin" /> Проверяем защиту...</div> : (
        <>
          <div className={`security-status ${status.enabled ? "is-enabled" : ""}`}><span><ShieldCheck /></span><div><strong>{status.enabled ? "Защита включена" : "Защита выключена"}</strong><small>{status.enabled ? `${status.recoveryCodesRemaining} recovery codes осталось` : "Вход пока защищён только паролем"}</small></div></div>
          {error && <div className="form-error" role="alert">{error}</div>}
          {!status.enabled && !setup && <div className="security-form"><Field label="Текущий пароль" type="password" value={password} onChange={setPassword} autoComplete="current-password" placeholder="Подтверди, что это ты" /><button type="button" className="button button--dark" disabled={!password || busy} onClick={() => void startSetup()}>{busy && <LoaderCircle className="spin" />} Настроить 2FA</button></div>}
          {!status.enabled && setup && <div className="two-factor-setup"><div className="qr-panel">{qrCodeUrl ? <img src={qrCodeUrl} alt="QR-код для приложения-аутентификатора" /> : <LoaderCircle className="spin" />}<div><strong>1. Отсканируй QR-код</strong><p>Или введи секрет вручную:</p><code>{setup.secret}</code></div></div><div className="security-form"><Field label="2. Код из приложения" value={code} onChange={setCode} inputMode="numeric" autoComplete="one-time-code" maxLength={6} placeholder="000000" /><button type="button" className="button button--accent" disabled={!code || busy} onClick={() => void enable()}>{busy && <LoaderCircle className="spin" />} Включить защиту</button><button type="button" className="button button--outline" onClick={() => { setSetup(null); setCode(""); }}>Отмена</button></div></div>}
          {status.enabled && <div className="security-form"><Field label="Код TOTP или recovery code" value={code} onChange={setCode} autoComplete="one-time-code" maxLength={19} placeholder="000000" /><Field label="Текущий пароль — только для отключения" type="password" value={password} onChange={setPassword} autoComplete="current-password" placeholder="Пароль" /><div className="security-actions"><button type="button" className="button button--outline" disabled={!code || busy} onClick={() => void regenerate()}><RefreshCw /> Новые recovery codes</button><button type="button" className="button danger-button" disabled={!code || !password || busy} onClick={() => void disable()}><LockKeyhole /> Отключить 2FA</button></div></div>}
          {recoveryCodes.length > 0 && <div className="recovery-panel"><div><strong>Сохрани recovery codes сейчас</strong><p>Каждый код одноразовый. После закрытия мы их больше не покажем.</p></div><div className="recovery-grid">{recoveryCodes.map((recoveryCode) => <code key={recoveryCode}>{recoveryCode}</code>)}</div><button type="button" className="button button--outline" onClick={() => void copyRecoveryCodes()}><Copy /> Скопировать все</button></div>}
        </>
      )}
    </section>
  );
}

function FeedSkeleton() {
  return <div className="post-list">{[1, 2].map((item) => <div className="post-card skeleton-card" key={item}><div className="skeleton skeleton-head" /><div className="skeleton skeleton-photo" /><div className="skeleton skeleton-line" /><div className="skeleton skeleton-line skeleton-line--short" /></div>)}</div>;
}

function PageLoader() {
  return <div className="page-loader"><span className="brand-mark"><span /></span><p>Загружаем...</p></div>;
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return <div className="state-card"><span className="state-emoji">🫠</span><h2>Что-то пошло не по плану</h2><p>{message}</p><button className="button button--dark" onClick={onRetry}>Попробовать ещё раз</button></div>;
}

function EmptyFeed({ scope }: { scope: "all" | "following" }) {
  return <div className="state-card"><span className="state-emoji">✦</span><h2>{scope === "following" ? "Лента подписок пуста" : "Здесь пока пусто"}</h2><p>{scope === "following" ? "Подпишись на авторов, чтобы видеть их публикации." : "Опубликуй первый кадр."}</p><Link className="button button--accent" to={scope === "following" ? "/" : "/create"}>{scope === "following" ? "Смотреть всё" : "Создать публикацию"}</Link></div>;
}

function NotFoundPage() {
  return <div className="state-card state-card--standalone"><span className="state-code">404</span><h1>Страница не найдена</h1><p>Возможно, ссылка устарела или в ней ошибка.</p><Link className="button button--dark" to="/">В ленту</Link></div>;
}

function uniqueAuthors(posts: Post[]) {
  const seen = new Set<number>();
  return posts.map((post) => post.author).filter((author) => !seen.has(author.id) && seen.add(author.id));
}

function getError(error: unknown) {
  if (error instanceof ApiError || error instanceof Error) return error.message;
  return "Что-то пошло не так. Попробуй ещё раз.";
}

function formatCount(value: number) {
  if (value >= 1000) return `${(value / 1000).toFixed(value >= 10000 ? 0 : 1).replace(".0", "")}к`;
  return String(value);
}

function categoryName(category: string) {
  return ({
    spam: "Спам",
    abuse: "Травля",
    nudity: "Откровенный контент",
    violence: "Насилие",
    copyright: "Авторские права",
    other: "Другое",
  } as Record<string, string>)[category] ?? category;
}

function relativeTime(dateString: string) {
  const timestamp = new Date(dateString).getTime();
  const diffMinutes = Math.max(1, Math.floor((Date.now() - timestamp) / 60000));
  if (diffMinutes < 60) return `${diffMinutes} мин`;
  if (diffMinutes < 1440) return `${Math.floor(diffMinutes / 60)} ч`;
  if (diffMinutes < 10080) return `${Math.floor(diffMinutes / 1440)} д`;
  return new Intl.DateTimeFormat("ru", { day: "numeric", month: "short" }).format(timestamp);
}
