import { useCallback, useEffect, useRef, useState, useMemo } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  FilmSlate,
  Lightbulb,
  Plus,
  Question,
  X,
} from '@phosphor-icons/react';
import type { Project } from '@yap/contracts';
import type { SocialHandoff } from '@yap/contracts/social';
import { api, messageOf } from './api';
import { PageHeading } from './components';
import { NewProject } from './NewProject';
import { ProjectLibrary } from './ProjectLibrary';
import { ProjectEditor } from './ProjectEditor';
import { LandingPage } from './landing/LandingPage';
import { PromoLibrary } from './promo/PromoLibrary';
import { CreatorLibrary } from './CreatorLibrary';
import { CreationWorkspace } from './creation/CreationWorkspace';
import { ReferenceRoom } from './creation/ReferenceRoom';
import { referenceIdsFromRoute, routePath } from './creation/bridge';
import { readPendingResearch, savePendingResearch } from './research-context';

function currentRoute() {
  return window.location.hash.replace(/^#/, '') || '/';
}

export function App() {
  const [route, setRoute] = useState(currentRoute);
  const [creationKey, setCreationKey] = useState(() => crypto.randomUUID());
  const path = routePath(route);
  const referenceIds = useMemo(() => referenceIdsFromRoute(route), [route]);
  const analyticsEntry =
    path === '/social' || new URLSearchParams(route.split('?')[1]).get('view') === 'analytics';
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [dirty, setDirty] = useState(false);
  const [pendingRoute, setPendingRoute] = useState('');
  const [about, setAbout] = useState(false);
  const [research, setResearch] = useState<SocialHandoff | undefined>(readPendingResearch);
  const routeRef = useRef(route);
  const dirtyRef = useRef(false);
  const dialogRef = useRef<HTMLElement>(null);
  const navigationNoticeRef = useRef<HTMLDivElement>(null);
  const navigationFocusRef = useRef<HTMLElement | null>(null);
  const preserveFocus = useRef(false);
  const changeDirty = useCallback((value: boolean) => {
    dirtyRef.current = value;
    setDirty(value);
  }, []);
  const acceptRoute = useCallback(
    (next: string, preserveCreation = false) => {
      preserveFocus.current = preserveCreation;
      navigationFocusRef.current = null;
      routeRef.current = next;
      setRoute(next);
      if (!preserveCreation) setCreationKey(crypto.randomUUID());
      if (!preserveCreation) changeDirty(false);
      setPendingRoute('');
      if (!preserveCreation) window.scrollTo({ top: 0 });
    },
    [changeDirty],
  );
  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setProjects((await api.list()).projects);
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const change = () => {
      const next = currentRoute();
      if (next === routeRef.current) return;
      if (dirtyRef.current && next !== routeRef.current) {
        navigationFocusRef.current =
          document.activeElement instanceof HTMLElement ? document.activeElement : null;
        window.history.replaceState(null, '', `#${routeRef.current}`);
        setPendingRoute(next);
        return;
      }
      acceptRoute(next);
    };
    window.addEventListener('hashchange', change);
    return () => window.removeEventListener('hashchange', change);
  }, [refresh, acceptRoute]);
  useEffect(() => {
    if (path.startsWith('/projects') || path === '/new') void refresh();
  }, [route, refresh]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (dirty) event.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  useEffect(() => {
    document.title =
      path === '/references'
        ? 'Inspiration — Yap'
        : path === '/'
          ? 'yap. — good ideas, made REEL'
          : path === '/films'
            ? 'Your films — Yap'
            : path === '/create' || path.startsWith('/create/')
              ? 'Create your film — Yap'
              : path === '/promos/new'
                ? 'New photo promo — Yap'
                : path.startsWith('/promos/')
                  ? 'Your photo promo — Yap'
                  : path === '/promos'
                    ? 'Your promos — Yap'
                    : path === '/social'
                      ? 'Social research — Yap'
                      : path === '/new'
                        ? 'New project — Yap'
                        : path.startsWith('/projects/')
                          ? 'Your studio — Yap'
                          : 'Your projects — Yap';
  }, [route]);
  useEffect(() => {
    if (preserveFocus.current) {
      preserveFocus.current = false;
      return;
    }
    if (route !== '/') document.getElementById('main')?.focus();
  }, [route]);
  useEffect(() => {
    savePendingResearch(research);
  }, [research]);
  useEffect(() => {
    if (pendingRoute) navigationNoticeRef.current?.querySelector('button')?.focus();
    else if (navigationFocusRef.current?.isConnected) {
      navigationFocusRef.current.focus();
      navigationFocusRef.current = null;
    }
  }, [pendingRoute]);
  useEffect(() => {
    if (!about) return;
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusable = () =>
      Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(
          'button, a[href], input, textarea, select, [tabindex="0"]',
        ) ?? [],
      );
    focusable()[0]?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setAbout(false);
      }
      if (event.key !== 'Tab') return;
      const elements = focusable();
      const first = elements[0],
        last = elements[elements.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener('keydown', keydown);
    return () => {
      document.removeEventListener('keydown', keydown);
      previousFocus?.focus();
    };
  }, [about]);

  function navigate(next: string, force = false, preserveCreation = false) {
    if (next === routeRef.current) return;
    if (dirtyRef.current && !force) {
      navigationFocusRef.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setPendingRoute(next);
      return;
    }
    window.history.pushState(null, '', `#${next}`);
    acceptRoute(next, preserveCreation);
  }
  const projectId = /^\/projects\/([a-f0-9-]+)$/.exec(path)?.[1];
  const promoId = /^\/promos\/([a-f0-9-]+)$/.exec(path)?.[1];
  const creatorId = /^\/create\/([a-f0-9-]+)$/.exec(path)?.[1];
  if (path === '/') {
    return (
      <LandingPage
        onEnterStudio={() => navigate('/create')}
        onOpenSocial={() => navigate('/create?view=analytics')}
        onOpenInspiration={() => navigate('/references')}
        onUseReferences={(ids) =>
          navigate(`/create?${ids.map((id) => `reference=${encodeURIComponent(id)}`).join('&')}`)
        }
      />
    );
  }
  return (
    <div className="app-shell">
      <a
        className="skip-link"
        href="#main"
        onClick={(event) => {
          event.preventDefault();
          const main = document.getElementById('main');
          main?.focus();
          main?.scrollIntoView();
        }}
      >
        Skip to content
      </a>
      <aside className="sidebar">
        <button className="brand" onClick={() => navigate('/')} aria-label="Yap home">
          yap<span>.</span>
        </button>
        <p className="brand-tagline">good ideas, made REEL</p>
        <div className="workspace-switch">
          <div className="workspace-avatar">
            <FilmSlate size={22} />
          </div>
          <div>
            <strong>Your workspace</strong>
            <span>Creator studio</span>
          </div>
        </div>
        <button
          className="workspace-new"
          onClick={() =>
            navigate(
              path === '/create' && !creatorId ? `/create?draft=${crypto.randomUUID()}` : '/create',
            )
          }
        >
          <Plus size={20} /> New creation
        </button>
        <nav className="side-nav" aria-label="Workspace">
          <button
            className={path !== '/references' ? 'nav-item current' : 'nav-item'}
            onClick={() => navigate('/films')}
            aria-current={path !== '/references' ? 'page' : undefined}
          >
            <FilmSlate size={20} /> Your creations
          </button>
          <button
            className={path === '/references' ? 'nav-item current' : 'nav-item'}
            onClick={() => navigate('/references')}
            aria-current={path === '/references' ? 'page' : undefined}
          >
            <Lightbulb size={20} /> Inspiration
          </button>
          <button className="nav-item" onClick={() => setAbout(true)} aria-haspopup="dialog">
            <Question size={20} /> Workspace guide
          </button>
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-tip">
            <Lightbulb size={22} weight="light" />
            <p>One place for your idea, research, photos, and finished film.</p>
          </div>
          <span className="sidebar-version">A little idea. A real beginning.</span>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <div className="breadcrumb">
            <span>Workspace</span>
            <span>/</span>
            <strong>
              {path === '/references'
                ? 'Inspiration'
                : path === '/films'
                  ? 'Your creations'
                  : path === '/create' || creatorId
                    ? 'Your film studio'
                    : path === '/promos/new'
                      ? 'New photo promo'
                      : promoId
                        ? 'Review and render'
                        : path === '/promos'
                          ? 'Your promos'
                          : path === '/social'
                            ? 'Creation analytics'
                            : path === '/new'
                              ? 'New script project'
                              : projectId
                                ? 'Script studio'
                                : 'Script projects'}
            </strong>
          </div>
          <div className="topbar-note">
            <span className="coral-dot" /> An idea → a film
          </div>
        </header>
        <main
          id="main"
          className={
            path.startsWith('/promos') || path.startsWith('/create')
              ? 'main-content promo-main'
              : 'main-content'
          }
          tabIndex={-1}
        >
          {pendingRoute && (
            <div ref={navigationNoticeRef} className="notice navigation-notice" role="alert">
              <span>You have unsaved changes. Leave this page?</span>
              <button className="text-button" onClick={() => setPendingRoute('')}>
                Keep editing
              </button>
              <button className="button button-danger" onClick={() => navigate(pendingRoute, true)}>
                Discard changes
              </button>
            </div>
          )}
          {['/films', '/promos', '/projects'].includes(path) && (
            <nav className="creation-library-tabs" aria-label="Saved creation formats">
              <button
                className={path === '/films' ? 'current' : ''}
                onClick={() => navigate('/films')}
                aria-current={path === '/films' ? 'page' : undefined}
              >
                Generated films
              </button>
              <button
                className={path === '/promos' ? 'current' : ''}
                onClick={() => navigate('/promos')}
                aria-current={path === '/promos' ? 'page' : undefined}
              >
                Photo reels
              </button>
              <button
                className={path === '/projects' ? 'current' : ''}
                onClick={() => navigate('/projects')}
                aria-current={path === '/projects' ? 'page' : undefined}
              >
                Script archive
              </button>
            </nav>
          )}
          {path === '/references' ? (
            <ReferenceRoom
              onDirty={changeDirty}
              onUseReferences={(ids) =>
                navigate(
                  `/create?${ids.map((id) => `reference=${encodeURIComponent(id)}`).join('&')}`,
                )
              }
            />
          ) : path === '/films' ? (
            <CreatorLibrary
              onCreate={() => navigate('/create')}
              onOpen={(id) => navigate(`/create/${id}`)}
            />
          ) : path === '/create' || creatorId || path === '/social' ? (
            <CreationWorkspace
              key={creationKey}
              id={creatorId}
              kind="video"
              initialView={analyticsEntry ? 'analytics' : 'create'}
              initialReferenceIds={referenceIds}
              onBack={() => navigate('/films')}
              onDirty={changeDirty}
              initialResearch={creatorId ? undefined : research}
              onOpenPromo={(id) => navigate(`/promos/${id}`)}
              onCreated={(id, kind) => {
                setResearch(undefined);
                navigate(kind === 'video' ? `/create/${id}` : `/promos/${id}`, true, true);
              }}
            />
          ) : path === '/promos' ? (
            <PromoLibrary
              onCreate={() => navigate('/promos/new')}
              onOpen={(id) => navigate(`/promos/${id}`)}
            />
          ) : path === '/promos/new' || promoId ? (
            <CreationWorkspace
              kind="photo"
              initialView={analyticsEntry ? 'analytics' : 'create'}
              key={creationKey}
              id={promoId}
              onBack={() => navigate('/promos')}
              onDirty={changeDirty}
              initialResearch={promoId ? undefined : research}
              onOpenPromo={(id) => navigate(`/promos/${id}`)}
              onCreated={(id, kind) => {
                setResearch(undefined);
                navigate(kind === 'video' ? `/create/${id}` : `/promos/${id}`, true, true);
              }}
            />
          ) : path === '/projects' ? (
            <ProjectLibrary
              projects={projects}
              loading={loading}
              error={error}
              onRetry={() => void refresh()}
              onCreate={() => navigate('/new')}
              onOpen={(id) => navigate(`/projects/${id}`)}
            />
          ) : path === '/new' ? (
            <NewProject
              onBack={() => navigate('/projects')}
              onDirty={changeDirty}
              onCreated={(project) => {
                changeDirty(false);
                void refresh();
                navigate(`/projects/${project.id}`, true);
              }}
            />
          ) : projectId ? (
            <ProjectEditor
              key={projectId}
              id={projectId}
              onBack={() => navigate('/projects')}
              onDirty={changeDirty}
              onUpdated={() => void refresh()}
              onDeleted={() => {
                changeDirty(false);
                void refresh();
                navigate('/projects', true);
              }}
            />
          ) : (
            <div className="not-found">
              <span className="eyebrow">A scene missing</span>
              <PageHeading
                title="This page isn’t in the plan."
                copy="Head back to your workspace to pick up your next idea."
              />
              <button className="button button-primary" onClick={() => navigate('/films')}>
                <ArrowLeft size={18} />
                Back to your creations
              </button>
            </div>
          )}
        </main>
        <footer className="workspace-footer">
          <span>Made for the idea you can’t stop thinking about.</span>
          <span>yap.</span>
        </footer>
      </div>
      {about && (
        <div className="modal-backdrop" onClick={() => setAbout(false)}>
          <section
            ref={dialogRef}
            className="about-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="about-title"
            onClick={(event) => event.stopPropagation()}
          >
            <button
              className="icon-button close-dialog"
              onClick={() => setAbout(false)}
              aria-label="Close about workspace"
            >
              <X size={22} />
            </button>
            <span className="small-brand">
              yap<span>.</span>
            </span>
            <h2 id="about-title">An idea deserves a first take.</h2>
            <p>
              Bring an idea, a product, a place, a public project link, or your own photos. Develop
              the direction in Guided view and review the script and shots in Director view.
            </p>
            <p>
              Guided proposals use structured templates and your supplied facts. The optional model
              provider can help refine the idea. You review and approve the current proposal before
              any video is rendered.
            </p>
            <p>
              The photo promo renderer makes silent videos from your uploaded photos. Generated
              clips use the configured video provider after you review the current plan and its
              generation limits. Nothing is posted to social accounts automatically.
            </p>
            <button className="button button-secondary" onClick={() => setAbout(false)}>
              Back to creating <ArrowRight size={18} />
            </button>
          </section>
        </div>
      )}
    </div>
  );
}
