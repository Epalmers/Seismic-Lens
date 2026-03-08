interface InfoTipProps {
  /** Tooltip content shown on hover/focus */
  text: string;
  /** Accessible label (announced to screen readers) */
  ariaLabel?: string;
  /** Icon: "i" for ⓘ (default), "?" for question mark */
  symbol?: "i" | "?";
  /** Placement: "bottom" (default) avoids clipping at viewport top */
  placement?: "top" | "bottom";
  /** Align: "start" avoids left clipping on leftmost items; "center" (default) centers tooltip */
  align?: "start" | "center";
}

/**
 * Small info icon that shows a tooltip on hover/focus.
 * Defaults to bottom placement to avoid clipping near viewport top.
 * Use align="start" for leftmost items to avoid left-side clipping.
 * Pure Tailwind; no new dependencies. Accessible (tabIndex=0, aria-label).
 */
export default function InfoTip({ text, ariaLabel, symbol = "i", placement = "bottom", align = "center" }: InfoTipProps) {
  const label = ariaLabel ?? text;
  const icon = symbol === "?" ? "?" : "ⓘ";
  const above = placement === "top";
  const alignStart = align === "start";
  return (
    <span className="group/infotip relative inline-flex">
      <span
        tabIndex={0}
        role="button"
        aria-label={label}
        className="flex h-4 w-4 cursor-pointer items-center justify-center rounded-full bg-slate-100 text-[10px] font-semibold text-slate-400 transition-colors hover:bg-slate-200 hover:text-slate-600 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1 focus:ring-offset-white"
      >
        {icon}
      </span>
      <span
        className={`pointer-events-none absolute z-[100] w-[260px] rounded-lg border border-slate-200 bg-slate-800 px-3 py-2 text-left text-xs leading-relaxed text-white opacity-0 shadow-lg transition-opacity group-hover/infotip:opacity-100 group-focus-within/infotip:opacity-100 ${
          alignStart ? "left-0" : "left-1/2 -translate-x-1/2"
        } ${above ? "bottom-full mb-1.5" : "top-full mt-1.5"}`}
        role="tooltip"
      >
        {text}
      </span>
    </span>
  );
}
