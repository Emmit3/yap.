import type { CreatorOutputProfileId } from '@yap/contracts/creator';
import { useId } from 'react';

export interface OutputProfileControlProps {
  value?: CreatorOutputProfileId;
  disabled?: boolean;
  onChange(profileId: CreatorOutputProfileId | undefined): void;
}

const choices: readonly { id: CreatorOutputProfileId; label: string }[] = [
  { id: 'portrait-720', label: 'Portrait 720 × 1280 · native size' },
  { id: 'landscape-720', label: 'Landscape 1280 × 720 · native size' },
  { id: 'portrait-1080', label: 'Portrait 1080 × 1920 · resized from 720p' },
];

export function OutputProfileControl({ value, disabled, onChange }: OutputProfileControlProps) {
  const id = useId();
  return (
    <div className="creator-field">
      <label htmlFor={id}>Delivery size</label>
      <select
        id={id}
        value={value ?? ''}
        disabled={disabled}
        aria-describedby={`${id}-help`}
        onChange={(event) => {
          if (!event.target.value) onChange(undefined);
          else {
            const choice = choices.find((item) => item.id === event.target.value);
            if (choice) onChange(choice.id);
          }
        }}
      >
        <option value="">Keep existing portrait 1080p delivery</option>
        {choices.map((choice) => (
          <option key={choice.id} value={choice.id}>
            {choice.label}
          </option>
        ))}
      </select>
      <p id={`${id}-help`}>
        Match the shot orientation to the delivery size. The 1080p option enlarges 720p footage; it
        does not generate additional source detail.
      </p>
    </div>
  );
}
