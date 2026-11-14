import { useEffect, useRef } from 'react';
import { destinationForShowcaseMessage } from './messages';
import './landing.css';

export interface LandingPageProps {
  onEnterStudio: () => void;
  onOpenSocial: () => void;
}

export function LandingPage({ onEnterStudio, onOpenSocial }: LandingPageProps) {
  const frameRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    const navigate = (event: MessageEvent<unknown>) => {
      const destination = destinationForShowcaseMessage(
        event,
        window.location.origin,
        frameRef.current?.contentWindow ?? null,
      );

      if (destination === 'studio') onEnterStudio();
      if (destination === 'social') onOpenSocial();
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
