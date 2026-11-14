import { useMemo, useState } from 'react';
import { ArrowRight, ArrowUpRight, FilmStrip, MagnifyingGlass, Plus } from '@phosphor-icons/react';
import type { Project } from '@yap/contracts';
import {
  ErrorNotice,
  FilmSketch,
  LoadingState,
  platformNames,
  Status,
  timeAgo,
} from './components';

export function ProjectLibrary({
  projects,
  loading,
  error,
  onRetry,
  onCreate,
  onOpen,
}: {
  projects: Project[];
  loading: boolean;
  error: string;
  onRetry(): void;
  onCreate(): void;
  onOpen(id: string): void;
}) {
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'all' | 'draft' | 'ready'>('all');
  const visible = useMemo(
    () =>
      projects
        .filter(
          (project) =>
            (filter === 'all' || project.status === filter) &&
            `${project.title} ${project.idea} ${project.audience}`
              .toLowerCase()
              .includes(search.toLowerCase()),
        )
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [projects, search, filter],
  );

  return (
    <>
      <section className="welcome-panel">
        <div className="welcome-copy">
          <p className="eyebrow">
            <span className="coral-dot" /> Your creative space
          </p>
          <h1>
            Good ideas.
            <br />
            Let’s make them <span>reel.</span>
          </h1>
          <p>A place for the idea in your head to become a video you’re ready to make.</p>
          <button className="button button-primary" onClick={onCreate}>
            Start with an idea <ArrowRight size={18} />
          </button>
        </div>
        <div className="welcome-art">
          <span className="art-caption">FROM FIRST THOUGHT TO FIRST TAKE</span>
          <FilmSketch />
          <div className="art-footnote">
            <span>Brief</span>
            <span>Script</span>
            <span>Shot plan</span>
          </div>
        </div>
      </section>
      <section className="library-section" aria-labelledby="projects-heading">
        <div className="section-heading">
          <div className="title-with-count">
            <h2 id="projects-heading">Your projects</h2>
            <span className="count-pill">{projects.length}</span>
          </div>
          <button className="text-button" onClick={onCreate}>
            <Plus size={18} /> New project
          </button>
        </div>
        <div className="library-controls">
          <div className="segmented-control" aria-label="Filter projects">
            {(['all', 'draft', 'ready'] as const).map((item) => (
              <button
                key={item}
                className={filter === item ? 'selected' : ''}
                aria-pressed={filter === item}
                onClick={() => setFilter(item)}
              >
                {item === 'all' ? 'All projects' : item === 'draft' ? 'Drafts' : 'Ready to film'}
              </button>
            ))}
          </div>
          <div className="search-field">
            <MagnifyingGlass size={18} />
            <input
              aria-label="Search projects"
              placeholder="Search your projects"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>
        {error ? (
          <div className="offline-panel">
            <ErrorNotice message={error} onRetry={onRetry} />
            <p>Your projects will appear when the connection is restored.</p>
          </div>
        ) : loading ? (
          <LoadingState />
        ) : projects.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon">
              <FilmStrip size={30} weight="light" />
            </div>
            <h3>Every good video starts somewhere.</h3>
            <p>
              Save your first idea. We’ll help you give it a script, a little structure, and a plan
              for the camera.
            </p>
            <button className="button button-secondary" onClick={onCreate}>
              <Plus size={18} />
              Create your first project
            </button>
            <span className="empty-note">Your ideas live here. Make yourself at home.</span>
          </div>
        ) : visible.length === 0 ? (
          <div className="empty-state compact">
            <MagnifyingGlass size={28} />
            <h3>No projects found</h3>
            <p>Try another search or show all your projects.</p>
            <button
              className="text-button"
              onClick={() => {
                setSearch('');
                setFilter('all');
              }}
            >
              Clear filters <ArrowRight size={16} />
            </button>
          </div>
        ) : (
          <div className="project-grid">
            {visible.map((project, index) => (
              <button className="project-card" key={project.id} onClick={() => onOpen(project.id)}>
                <div className={`project-cover cover-${index % 3}`}>
                  <div className="cover-top">
                    <span>{platformNames[project.platform]}</span>
                    <span>{project.duration}s</span>
                  </div>
                  <div className="cover-mark">
                    <FilmStrip size={40} weight="light" />
                    <span>
                      {project.draft
                        ? `${project.draft.shots.length} shots, one story.`
                        : 'A good idea in progress.'}
                    </span>
                  </div>
                  <ArrowUpRight className="cover-arrow" size={24} />
                </div>
                <div className="project-card-body">
                  <div className="project-card-meta">
                    <Status status={project.status} />
                    <span>{timeAgo(project.updatedAt)}</span>
                  </div>
                  <h3>{project.title}</h3>
                  <p>{project.idea}</p>
                  <div className="project-card-footer">
                    <span>{project.draft ? 'Open in studio' : 'Continue your brief'}</span>
                    <ArrowRight size={18} />
                  </div>
                </div>
              </button>
            ))}
          </div>
        )}
      </section>
    </>
  );
}
