import React from 'react';
import { palette } from '../ui';

/** A settings group (module level: defined inside a component, its inputs would remount on every keystroke). */
export const Section = ({ title, children, aside }: { title: string; children: React.ReactNode; aside?: React.ReactNode }) => (
  <section className="surface flex flex-col gap-3 p-4">
    <div className="flex items-center justify-between gap-2">
      <h3 className="t-eyebrow" style={{ color: palette.textTertiary }}>{title}</h3>
      {aside}
    </div>
    {children}
  </section>
);
