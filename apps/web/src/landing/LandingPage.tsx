import { useEffect, useRef } from 'react';
import './landing.css';

export interface LandingPageProps {
  onEnterStudio: () => void;
  onOpenSocial: () => void;
}

export function LandingPage({ onEnterStudio, onOpenSocial }: LandingPageProps) {
  const frameRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    const navigate = (event: MessageEvent<unknown>) => {
      const source = frameRef.current?.contentWindow;
      if (
        !source ||
        event.origin !== window.location.origin ||
        event.source !== source ||
        typeof event.data !== 'object' ||
        event.data === null ||
        !('type' in event.data)
      ) {
        return;
      }

      if (event.data.type === 'yap:enter-studio') onEnterStudio();
      if (event.data.type === 'yap:open-social') onOpenSocial();
    };

    window.addEventListener('message', navigate);
    return () => window.removeEventListener('message', navigate);
  }, [onEnterStudio, onOpenSocial]);

  return (
    <main className="landing-page" aria-label="Yap cinematic homepage">
      <iframe
        ref={frameRef}
        className="landing-page__frame"
        src="/showcase/index.html?embedded=1"
        title="Yap — good ideas, made REEL"
        allow="autoplay; fullscreen"
        allowFullScreen
      />
    </main>
  );
}
