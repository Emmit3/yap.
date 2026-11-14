import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  FilmSlate,
  FolderSimple,
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
import { PromoWorkspace } from './promo/PromoWorkspace';
import { PromoLibrary } from './promo/PromoLibrary';
import SocialWorkspace from './social/SocialWorkspace';
import {
  readPendingResearch,
  savePendingResearch,
  validateResearchContext,
} from './research-context';

function currentRoute() {
  return window.location.hash.replace(/^#/, '') || '/';
}

export function App() {
  const [route, setRoute] = useState(currentRoute);
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
  const changeDirty = useCallback((value: boolean) => {
    dirtyRef.current = value;
    setDirty(value);
  }, []);
  const acceptRoute = useCallback(
    (next: string) => {
      navigationFocusRef.current = null;
      routeRef.current = next;
      setRoute(next);
      changeDirty(false);
      setPendingRoute('');
      window.scrollTo({ top: 0 });
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
    if (route.startsWith('/projects') || route === '/new') void refresh();
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
      route === '/'
        ? 'yap. — good ideas, made REEL'
        : route === '/promos/new'
          ? 'New photo promo — Yap'
          : route.startsWith('/promos/')
            ? 'Your photo promo — Yap'
            : route === '/promos'
              ? 'Your promos — Yap'
              : route === '/social'
                ? 'Social research — Yap'
                : route === '/new'
                  ? 'New project — Yap'
                  : route.startsWith('/projects/')
                    ? 'Your studio — Yap'
                    : 'Your projects — Yap';
  }, [route]);
  useEffect(() => {
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

  function navigate(next: string, force = false) {
    if (next === routeRef.current) return;
    if (dirtyRef.current && !force) {
      navigationFocusRef.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setPendingRoute(next);
      return;
    }
    window.history.pushState(null, '', `#${next}`);
    acceptRoute(next);
  }
  const projectId = /^\/projects\/([a-f0-9-]+)$/.exec(route)?.[1];
  const promoId = /^\/promos\/([a-f0-9-]+)$/.exec(route)?.[1];
  if (route === '/') {
    return (
      <LandingPage
        onEnterStudio={() => navigate('/promos/new')}
        onOpenSocial={() => navigate('/social')}
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
        <nav className="side-nav" aria-label="Workspace">
          <span className="nav-label">WORKSPACE</span>
          <button
            className={
              route.startsWith('/promos') && route !== '/promos/new'
                ? 'nav-item current'
                : 'nav-item'
            }
            onClick={() => navigate('/promos')}
            aria-current={route === '/promos' ? 'page' : undefined}
          >
            <FilmSlate size={20} />
            Your promos
          </button>
          <button
            className={route === '/promos/new' ? 'nav-item current' : 'nav-item'}
            onClick={() => navigate('/promos/new')}
            aria-current={route === '/promos/new' ? 'page' : undefined}
          >
            <Plus size={20} />
            New promo
          </button>
          <button
            className={route === '/social' ? 'nav-item current' : 'nav-item'}
            onClick={() => navigate('/social')}
            aria-current={route === '/social' ? 'page' : undefined}
          >
            <Lightbulb size={20} />
            Social research
          </button>
          <button
            className={route.startsWith('/projects') ? 'nav-item current' : 'nav-item'}
            onClick={() => navigate('/projects')}
            aria-current={route === '/projects' ? 'page' : undefined}
          >
            <FolderSimple size={20} />
            Script projects<span className="nav-count">{projects.length}</span>
          </button>
          <button
            className={route === '/new' ? 'nav-item current' : 'nav-item'}
            onClick={() => navigate('/new')}
            aria-current={route === '/new' ? 'page' : undefined}
          >
            <Plus size={20} />
            Script planner
          </button>
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-tip">
            <Lightbulb size={22} weight="light" />
            <p>Your own photos. A little idea. A promo ready for your next post.</p>
          </div>
          <button className="nav-item about-button" onClick={() => setAbout(true)}>
            <Question size={20} />
            About this workspace
          </button>
          <span className="sidebar-version">A little idea. A real beginning.</span>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <div className="breadcrumb">
            <span>Workspace</span>
            <span>/</span>
            <strong>
              {route === '/promos/new'
                ? 'New photo promo'
                : promoId
                  ? 'Review and render'
                  : route === '/promos'
                    ? 'Your promos'
                    : route === '/social'
                      ? 'Social research'
                      : route === '/new'
                        ? 'New script project'
                        : projectId
                          ? 'Script studio'
                          : 'Script projects'}
            </strong>
          </div>
          <div className="topbar-note">
            <span className="coral-dot" /> Photos → story → reel
          </div>
        </header>
        <main
          id="main"
          className={route.startsWith('/promos') ? 'main-content promo-main' : 'main-content'}
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
          {route === '/promos/new' && research && (
            <aside className="research-context-notice" aria-label="Attached creative research">
              <div>
                <strong>Research context: {research.topic}</strong>
                <p>
                  Creative context from {research.sourceUrls.length} attributed sources is selected.
                  Add your own business facts and photos below. Research does not approve claims or
                  start a render.
                </p>
              </div>
              <button
                className="text-button"
                onClick={() => setResearch(undefined)}
                title="Clear the pending selection. Research already saved to a promo is kept with that promo."
              >
                Clear pending research
              </button>
            </aside>
          )}
          {route === '/social' ? (
            <SocialWorkspace
              onDirty={changeDirty}
              onUseResearch={(handoff) => {
                if (dirtyRef.current)
                  throw new Error(
                    'Save or discard your open note before sending research to a promo.',
                  );
                setResearch(validateResearchContext(handoff));
                navigate('/promos/new');
              }}
            />
          ) : route === '/promos' ? (
            <PromoLibrary
              onCreate={() => navigate('/promos/new')}
              onOpen={(id) => navigate(`/promos/${id}`)}
            />
          ) : route === '/promos/new' || promoId ? (
            <PromoWorkspace
              key={promoId ?? 'new-promo'}
              id={promoId}
              onBack={() => navigate('/promos')}
              onDirty={changeDirty}
              research={promoId ? undefined : research}
              onCreated={(id) => {
                setResearch(undefined);
                changeDirty(false);
                navigate(`/promos/${id}`, true);
              }}
            />
          ) : route === '/projects' ? (
            <ProjectLibrary
              projects={projects}
              loading={loading}
              error={error}
              onRetry={() => void refresh()}
              onCreate={() => navigate('/new')}
              onOpen={(id) => navigate(`/projects/${id}`)}
            />
          ) : route === '/new' ? (
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
              <button className="button button-primary" onClick={() => navigate('/promos')}>
                <ArrowLeft size={18} />
                Back to promos
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
              Bring your business idea and photos, review an editable proposal, then approve it to
              render a portrait MP4 and caption.
            </p>
            <p>
              Guided proposals use structured templates and your supplied facts. The optional model
              provider can help refine the idea. You review and approve the current proposal before
              any video is rendered.
            </p>
            <p>
              Videos use your uploaded photos and are silent. Nothing is posted to social accounts
              automatically. Your connected Yap server saves the work; this local version has no
              sign in or team accounts.
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
