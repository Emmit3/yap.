import type {
  CreatorClip,
  CreatorVideoProfileId,
  CreatorVideoProfileOption,
} from '@yap/contracts/creator';

export interface ClipProviderControlProps {
  clip: CreatorClip;
  profiles: readonly CreatorVideoProfileOption[];
  disabled?: boolean;
  onChange(profileId: CreatorVideoProfileId | undefined): void;
}

export function ClipProviderControl({
  clip,
  profiles,
  disabled,
  onChange,
}: ClipProviderControlProps) {
  const id = `creator-clip-profile-${clip.id}`;
  const selected = profiles.find((profile) => profile.id === clip.videoProfileId);
  const missingImage = selected?.requiresImage && !clip.assetId && !clip.storyboardFrameId;
  const invalidSeconds =
    selected &&
    (clip.seconds < selected.minSeconds ||
      clip.seconds > selected.maxSeconds ||
      (selected.allowedSeconds && !selected.allowedSeconds.includes(clip.seconds)));
  return (
    <div className="creator-field">
      <label htmlFor={id}>Video model for this shot</label>
      <select
        id={id}
        value={clip.videoProfileId ?? ''}
        disabled={disabled}
        aria-describedby={`${id}-help`}
        onChange={(event) => {
          if (!event.target.value) onChange(undefined);
          else {
            const profile = profiles.find((item) => item.id === event.target.value);
            if (profile) onChange(profile.id);
          }
        }}
      >
        <option value="">Use saved plan provider</option>
        {profiles.map((profile) => (
          <option
            key={profile.id}
            value={profile.id}
            disabled={!profile.configured || profile.retired}
          >
            {profile.label}
            {profile.retired ? ' · unavailable' : !profile.configured ? ' · not configured' : ''}
          </option>
        ))}
      </select>
      <p id={`${id}-help`}>
        {selected
          ? `${selected.nativeWidth} × ${selected.nativeHeight} native pixels. ${selected.allowedSeconds ? `${selected.allowedSeconds.join(' or ')} seconds.` : `${selected.minSeconds} to ${selected.maxSeconds} seconds.`}`
          : 'Keep the saved provider, or explicitly choose a model for this shot.'}
        {selected?.unavailableReason ? ` ${selected.unavailableReason}` : ''}
        {missingImage ? ' Add an uploaded or approved storyboard image for this model.' : ''}
        {invalidSeconds ? ' Save a supported shot duration before requesting a quote.' : ''}
      </p>
    </div>
  );
}
