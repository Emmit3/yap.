import { useEffect, useRef } from 'react';
import { destinationForShowcaseMessage } from './messages';
import { referenceIdsFromMessage } from '../creation/bridge';
import './landing.css';

export interface LandingPageProps {
  onEnterStudio: () => void;
  onOpenSocial: () => void;
  onOpenInspiration?: () => void;
  onUseReferences?: (ids: string[]) => void;
  exampleMode?: boolean;
}

export function LandingPage({
  onEnterStudio,
  onOpenSocial,
  onUseReferences,
  onOpenInspiration,
  exampleMode = false,
}: LandingPageProps) {
  const frameRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    const navigate = (event: MessageEvent<unknown>) => {
      const references = referenceIdsFromMessage(
        event,
        window.location.origin,
        frameRef.current?.contentWindow ?? null,
      );
      if (references) {
        onUseReferences?.(references);
        return;
      }
      const destination = destinationForShowcaseMessage(
        event,
        window.location.origin,
        frameRef.current?.contentWindow ?? null,
      );

      if (destination === 'studio') onEnterStudio();
      if (destination === 'social') onOpenSocial();
      if (destination === 'inspiration') onOpenInspiration?.();
    };

    window.addEventListener('message', navigate);
    return () => window.removeEventListener('message', navigate);
  }, [onEnterStudio, onOpenSocial, onUseReferences, onOpenInspiration]);

  return (
    <main className="landing-page" aria-label="Yap cinematic homepage">
      <iframe
        ref={frameRef}
        className="landing-page__frame"
        src={`/showcase/index.html?embedded=1${exampleMode ? '&example=matcha' : ''}`}
        title="Yap — good ideas, made REEL"
        allow="autoplay; fullscreen"
        allowFullScreen
      />
    </main>
  );
}
