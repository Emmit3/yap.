import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  FilmSlate,
  FolderSimple,
  Lightbulb,
  Plus,
  Question,
  Graph,
  X,
} from '@phosphor-icons/react';
import type { Project } from '@yap/contracts';
import { socialHandoffSchema, type SocialHandoff } from '@yap/contracts/social';
import { api, messageOf } from './api';
import { PageHeading } from './components';
import { NewProject } from './NewProject';
import { ProjectLibrary } from './ProjectLibrary';
import { ProjectEditor } from './ProjectEditor';
import SocialWorkspace from './social/SocialWorkspace';

function currentRoute() {
  return window.location.hash.replace(/^#/, '') || '/projects';
}

export function App() {
  const [research, setResearch] = useState<SocialHandoff | undefined>(() => {
    try {
      const saved = sessionStorage.getItem('yap-research-direction');
      const parsed = socialHandoffSchema.safeParse(saved ? JSON.parse(saved) : undefined);
      return parsed.success ? parsed.data : undefined;
    } catch { return undefined; }
  });
  const [route, setRoute] = useState(currentRoute);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [dirty, setDirty] = useState(false);
  const [pendingRoute, setPendingRoute] = useState('');
  const [about, setAbout] = useState(false);
  const routeRef = useRef(route);
  const dirtyRef = useRef(false);
  const dialogRef = useRef<HTMLElement>(null);
  const changeDirty = useCallback((value: boolean) => {
    dirtyRef.current = value;
    setDirty(value);
  }, []);
  const acceptRoute = useCallback(
    (next: string) => {
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
    void refresh();
    const change = () => {
      const next = currentRoute();
      if (next === routeRef.current) return;
      if (dirtyRef.current && next !== routeRef.current) {
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
    const warn = (event: BeforeUnloadEvent) => {
      if (dirty) event.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  useEffect(() => {
    document.title =
      route === '/research'
        ? 'Research — Yap'
        : route === '/new'
        ? 'New project — Yap'
        : route.startsWith('/projects/')
          ? 'Your studio — Yap'
          : 'Your projects — Yap';
  }, [route]);
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
      setPendingRoute(next);
      return;
    }
    window.history.pushState(null, '', `#${next}`);
    acceptRoute(next);
  }
  const projectId = /^\/projects\/([a-f0-9-]+)$/.exec(route)?.[1];
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
        <button className="brand" onClick={() => navigate('/projects')} aria-label="Yap home">
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
            className={route.startsWith('/projects') ? 'nav-item current' : 'nav-item'}
            onClick={() => navigate('/projects')}
            aria-current={route === '/projects' ? 'page' : undefined}
          >
            <FolderSimple size={20} />
            Projects<span className="nav-count">{projects.length}</span>
          </button>
          <button
            className={route === '/new' ? 'nav-item current' : 'nav-item'}
            onClick={() => navigate('/new')}
            aria-current={route === '/new' ? 'page' : undefined}
          >
            <Plus size={20} />
            New project
          </button>
          <button
            className={route === '/research' ? 'nav-item current' : 'nav-item'}
            onClick={() => navigate('/research')}
            aria-current={route === '/research' ? 'page' : undefined}
          >
            <Graph size={20} />
            Research
          </button>
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-tip">
            <Lightbulb size={22} weight="light" />
            <p>The best camera is the one you actually press record on.</p>
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
            <strong>{route === '/research' ? 'Research' : route === '/new' ? 'New project' : projectId ? 'Studio' : 'Projects'}</strong>
          </div>
          <div className="topbar-note">
            <span className="coral-dot" /> Made for your next take
          </div>
        </header>
        <main id="main" className="main-content" tabIndex={-1}>
          {pendingRoute && (
            <div className="notice navigation-notice" role="alert">
              <span>You have unsaved changes. Leave this page?</span>
              <button className="text-button" onClick={() => setPendingRoute('')}>
                Keep editing
              </button>
              <button className="button button-danger" onClick={() => navigate(pendingRoute, true)}>
                Discard changes
              </button>
            </div>
          )}
          {route === '/research' ? (
            <SocialWorkspace onDirty={changeDirty} onUseResearch={(handoff) => {
              setResearch(handoff);
              try { sessionStorage.setItem('yap-research-direction', JSON.stringify(handoff)); } catch { /* State still holds this direction. */ }
              navigate('/new');
            }} />
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
              initialResearch={research}
              onBack={() => navigate('/projects')}
              onDirty={changeDirty}
              onCreated={(project) => {
                setResearch(undefined);
                try { sessionStorage.removeItem('yap-research-direction'); } catch { /* Storage may be unavailable. */ }
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
              <button className="button button-primary" onClick={() => navigate('/projects')}>
                <ArrowLeft size={18} />
                Back to projects
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
              This workspace helps you plan short videos with a brief, an editable script, and a
              timed shot list.
            </p>
            <p>
              Guided drafts use a structured template. They’re a starting point for your words, and
              don’t render a video.
            </p>
            <p>
              Projects are saved by your connected Yap server. This local development version has no
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
