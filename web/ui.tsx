import React, { useEffect, useId, useRef, useState } from "react";

export const DraftScope = React.createContext("");

const paths: Record<string, string> = {
  services: "M3 5h18v14H3z M7 9h4m-2-2v4m6-2h2m-2 4h2",
  access: "M12 3l8 4v5c0 5-8 9-8 9s-8-4-8-9V7z M8 12l3 3 5-6",
  devices: "M3 4h18v13H3z M8 21h8m-4-4v4",
  tickets: "M4 5h16v12H9l-5 4z M8 9h8m-8 4h5",
  guides: "M3 4h7l2 2 2-2h7v15h-7l-2 2-2-2H3z M12 6v15",
  onboarding: "M12 3v18m-7-7 7 7 7-7 M4 3h16",
  notices: "M3 9h5l11-5v16L8 15H3z M8 15l2 6",
  notifications: "M5 17h14l-2-3V9a5 5 0 0 0-10 0v5z M10 21h4",
  admin: "M4 5h16M4 12h16M4 19h16 M8 2v6m8 1v6m-6 1v6",
  menu: "M3 6h18M3 12h18M3 18h18",
  close: "m5 5 14 14M19 5 5 19",
  theme: "M20 14A8 8 0 0 1 10 4a8 8 0 1 0 10 10z",
  star: "m12 3 3 6 7 1-5 5 1 7-6-4-6 4 1-7-5-5 7-1z",
};
export function Icon({ name }: { name: string }) {
  return (
    <svg
      className="icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name] ?? paths.services} />
    </svg>
  );
}
export function Emblem() {
  return (
    <svg className="emblem" viewBox="0 0 64 72" fill="none" aria-hidden="true">
      <path
        d="M32 3 58 14v34L32 69 6 48V14z"
        stroke="currentColor"
        strokeWidth="3"
      />
      <path
        d="M18 23h28M18 34h28M22 17v33m10-33v40m10-40v33"
        stroke="currentColor"
        strokeWidth="5"
      />
      <path d="m18 50 4 5 4-5m2 7 4 5 4-5m2-7 4 5 4-5" fill="currentColor" />
    </svg>
  );
}
export function Brand() {
  return (
    <>
      <Emblem />
      <span>PORTCULLIS</span>
    </>
  );
}
export function revealField(element: HTMLElement) {
  let parent = element.parentElement;
  while (parent) {
    if (parent instanceof HTMLDetailsElement) parent.open = true;
    parent = parent.parentElement;
  }
  element.focus();
}
export function allowNavigation(root: ParentNode = document) {
  return (
    !root.querySelector('[data-dirty="true"]') ||
    window.confirm(
      "Leave this editor with unsaved changes? Saved drafts stay in memory until you reload or sign out.",
    )
  );
}
function trapDialogFocus(event: React.KeyboardEvent<HTMLDialogElement>) {
  if (event.key !== "Tab") return;
  const items = Array.from(
    event.currentTarget.querySelectorAll<HTMLElement>(
      'button:not(:disabled), a[href], input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled), summary, [tabindex="0"]',
    ),
  ).filter((el) => el.getClientRects().length > 0);
  const target = event.shiftKey ? items.at(-1) : items[0];
  if (
    (event.shiftKey && document.activeElement === items[0]) ||
    (!event.shiftKey && document.activeElement === items.at(-1))
  ) {
    event.preventDefault();
    target?.focus();
  }
}
export function Modal({
  title,
  close,
  children,
  draftScope,
}: {
  title: string;
  draftScope?: string;
  close: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  useEffect(() => {
    const trigger = document.activeElement as HTMLElement | null;
    ref.current?.showModal();
    return () => {
      trigger?.focus();
    };
  }, []);
  const dismiss = () => {
    if (allowNavigation(ref.current!)) close();
  };
  return (
    <dialog
      ref={ref}
      onKeyDown={trapDialogFocus}
      onCancel={(e) => {
        e.preventDefault();
        dismiss();
      }}
      aria-labelledby={id}
    >
      <div className="dialog-head">
        <div>
          <p className="eyebrow">PORTCULLIS / CONTROL PANEL</p>
          <h2 id={id}>{title}</h2>
        </div>
        <button type="button" onClick={dismiss} aria-label="Close dialog">
          <Icon name="close" />
        </button>
      </div>
      <DraftScope.Provider value={draftScope ?? title}>
        {children}
      </DraftScope.Provider>
    </dialog>
  );
}
export type NavPage = { id: string; title: string; group: string };
export function Navigation({
  pages,
  page,
  navigate,
  account,
}: {
  pages: NavPage[];
  page: string;
  navigate: (id: string) => void;
  account: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const drawer = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (open) drawer.current?.showModal();
    else if (drawer.current?.open) {
      drawer.current.close();
      trigger.current?.focus();
    }
  }, [open]);
  useEffect(() => {
    const media = matchMedia("(min-width: 901px)");
    const resize = () => {
      if (media.matches) setOpen(false);
    };
    media.addEventListener("change", resize);
    return () => media.removeEventListener("change", resize);
  }, []);
  const content = (
    <>
      <a
        href="/"
        className="brand"
        onClick={(e) => {
          e.preventDefault();
          if (!allowNavigation()) return;
          navigate("services");
          setOpen(false);
        }}
      >
        <Brand />
      </a>
      <p className="eyebrow">YOUR COMMUNITY. CONNECTED.</p>
      <nav aria-label="Main navigation">
        {[...new Set(pages.map((p) => p.group))].map((group) => (
          <div className="nav-group" key={group}>
            <p className="nav-label">{group}</p>
            {pages
              .filter((p) => p.group === group)
              .map((p) => (
                <button
                  key={p.id}
                  className={page === p.id ? "selected" : ""}
                  aria-current={page === p.id ? "page" : undefined}
                  onClick={() => {
                    if (!allowNavigation()) return;
                    navigate(p.id);
                    setOpen(false);
                  }}
                >
                  <Icon name={p.id} />
                  {p.title}
                </button>
              ))}
          </div>
        ))}
      </nav>
      <div className="sidebar-bottom">{account}</div>
    </>
  );
  return (
    <>
      <aside className="desktop-nav">{content}</aside>
      <div className="mobile-header">
        <a
          className="brand"
          href="/"
          onClick={(e) => {
            e.preventDefault();
            if (!allowNavigation()) return;
            navigate("services");
          }}
        >
          <Brand />
        </a>
        <button
          ref={trigger}
          onClick={() => setOpen(true)}
          aria-label="Open navigation"
          aria-expanded={open}
          aria-controls="navigation-drawer"
        >
          <Icon name="menu" />
        </button>
      </div>
      <dialog
        id="navigation-drawer"
        className="nav-drawer"
        aria-label="Navigation"
        ref={drawer}
        onKeyDown={trapDialogFocus}
        onCancel={(e) => {
          e.preventDefault();
          setOpen(false);
        }}
      >
        <button
          className="drawer-close"
          onClick={() => setOpen(false)}
          aria-label="Close navigation"
        >
          <Icon name="close" />
        </button>
        {content}
      </dialog>
    </>
  );
}
