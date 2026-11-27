import { useRef } from "react";

export default function SectionDisclosure({ label, sections, selected, onSelect, summaryId }) {
  const disclosureRef = useRef(null);
  const summaryRef = useRef(null);
  const active = sections.find((section) => section.id === selected);

  return (
    <details
      ref={disclosureRef}
      className="section-disclosure"
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !disclosureRef.current.open) return;
        event.stopPropagation();
        disclosureRef.current.open = false;
        summaryRef.current.focus();
      }}
    >
      <summary ref={summaryRef} id={summaryId} className="section-disclosure-toggle" data-active={Boolean(active)}>
        {label}{active && <span>{active.label}</span>}
      </summary>
      <div className="section-disclosure-options">
        {sections.map((section) => (
          <button
            key={section.id}
            type="button"
            aria-current={section.id === selected ? "page" : undefined}
            onClick={() => {
              disclosureRef.current.open = false;
              summaryRef.current.focus();
              onSelect(section.id);
            }}
          >
            {section.label}
          </button>
        ))}
      </div>
    </details>
  );
}
