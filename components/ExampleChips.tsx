"use client";

type Props = {
  examples: string[];
  onPick: (text: string) => void;
  disabled?: boolean;
};

export default function ExampleChips({ examples, onPick, disabled }: Props) {
  return (
    <div
      className="grid gap-2 sm:grid-cols-2"
      data-testid="example-chips"
    >
      {examples.map((ex) => (
        <button
          key={ex}
          type="button"
          onClick={() => onPick(ex)}
          disabled={disabled}
          className="rounded-xl border border-stone-200 bg-white px-3 py-2.5 text-left text-sm text-stone-700 shadow-sm transition hover:border-emerald-300 hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-50"
          data-testid="example-chip"
        >
          {ex}
        </button>
      ))}
    </div>
  );
}
