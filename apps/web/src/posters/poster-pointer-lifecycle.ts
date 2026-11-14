export interface PosterPointerRelease {
  pointerId: number | null;
  timeStamp: number;
  cancelled: boolean;
}

/** Release can happen outside the stage before horizontal intent has captured the pointer. */
export function observePosterPointerRelease(
  windowTarget: EventTarget,
  stageTarget: EventTarget,
  release: (event: PosterPointerRelease) => void,
) {
  const pointer = (cancelled: boolean) => (event: Event) => {
    if (!('pointerId' in event) || typeof event.pointerId !== 'number') return;
    release({ pointerId: event.pointerId, timeStamp: event.timeStamp, cancelled });
  };
  const up = pointer(false);
  const cancel = pointer(true);
  const blur = (event: Event) =>
    release({ pointerId: null, timeStamp: event.timeStamp, cancelled: true });
  const capture = { capture: true };
  windowTarget.addEventListener('pointerup', up, capture);
  windowTarget.addEventListener('pointercancel', cancel, capture);
  windowTarget.addEventListener('blur', blur);
  stageTarget.addEventListener('lostpointercapture', cancel);
  return () => {
    windowTarget.removeEventListener('pointerup', up, capture);
    windowTarget.removeEventListener('pointercancel', cancel, capture);
    windowTarget.removeEventListener('blur', blur);
    stageTarget.removeEventListener('lostpointercapture', cancel);
  };
}
