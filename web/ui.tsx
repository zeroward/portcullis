import React, { useEffect, useId, useRef, useState } from "react";

export const DraftScope = React.createContext("");

let audioCtx: AudioContext | null = null;
let sfxMuted = false;
const sfxListeners = new Set<() => void>();

export function useSfxMuted(): [boolean, () => void] {
  const [muted, setMuted] = useState(sfxMuted);
  useEffect(() => {
    const listener = () => setMuted(sfxMuted);
    sfxListeners.add(listener);
    return () => {
      sfxListeners.delete(listener);
    };
  }, []);
  const toggle = () => {
    sfxMuted = !sfxMuted;
    sfxListeners.forEach((fn) => fn());
    if (!sfxMuted) playSfx("select");
  };
  return [muted, toggle];
}

export function playSfx(
  kind: "tick" | "select" | "back" | "deploy" = "select",
) {
  if (
    sfxMuted ||
    typeof window === "undefined" ||
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
  )
    return;
  try {
    const Ctx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!Ctx) return;
    audioCtx ??= new Ctx();
    if (audioCtx.state === "suspended") void audioCtx.resume();
    const now = audioCtx.currentTime;
    const master = audioCtx.createGain();
    master.connect(audioCtx.destination);

    if (kind === "tick") {
      const osc = audioCtx.createOscillator();
      osc.type = "sine";
      osc.frequency.setValueAtTime(960, now);
      osc.frequency.exponentialRampToValueAtTime(1420, now + 0.022);
      master.gain.setValueAtTime(0.025, now);
      master.gain.exponentialRampToValueAtTime(0.0008, now + 0.024);
      osc.connect(master);
      osc.start(now);
      osc.stop(now + 0.025);
    } else if (kind === "back") {
      const osc = audioCtx.createOscillator();
      osc.type = "triangle";
      osc.frequency.setValueAtTime(460, now);
      osc.frequency.exponentialRampToValueAtTime(210, now + 0.075);
      master.gain.setValueAtTime(0.045, now);
      master.gain.exponentialRampToValueAtTime(0.001, now + 0.08);
      osc.connect(master);
      osc.start(now);
      osc.stop(now + 0.082);
    } else if (kind === "deploy") {
      [523.25, 659.25, 1046.5].forEach((freq, idx) => {
        const osc = audioCtx!.createOscillator();
        const g = audioCtx!.createGain();
        osc.type = "triangle";
        const start = now + idx * 0.028;
        osc.frequency.setValueAtTime(freq, start);
        g.gain.setValueAtTime(0.035, start);
        g.gain.exponentialRampToValueAtTime(0.0008, start + 0.11);
        osc.connect(g);
        g.connect(master);
        osc.start(start);
        osc.stop(start + 0.115);
      });
    } else {
      [587.33, 880].forEach((freq, idx) => {
        const osc = audioCtx!.createOscillator();
        const g = audioCtx!.createGain();
        osc.type = idx === 0 ? "triangle" : "sine";
        osc.frequency.setValueAtTime(freq, now);
        osc.frequency.exponentialRampToValueAtTime(freq * 1.12, now + 0.065);
        g.gain.setValueAtTime(idx === 0 ? 0.04 : 0.025, now);
        g.gain.exponentialRampToValueAtTime(0.0008, now + 0.07);
        osc.connect(g);
        g.connect(master);
        osc.start(now);
        osc.stop(now + 0.072);
      });
    }
  } catch {
    /* Audio synthesis is optional and ignored when blocked by the browser. */
  }
}

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
  sound:
    "M11 5 6 9H2v6h4l5 4V5zM15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13",
  mute: "M11 5 6 9H2v6h4l5 4V5zM22 9l-6 6M16 9l6 6",
};
export function Icon({ name }: { name: string }) {
  return (
    <svg
      className="icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
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
        d="M32 2 60 13v35L32 70 4 48V13z"
        stroke="currentColor"
        strokeWidth="2.5"
      />
      <path
        d="M32 7 54 16v30L32 64 10 46V16z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeOpacity="0.45"
      />
      <path
        d="M18 23h28M18 34h28M22 17v33m10-33v40m10-40v33"
        stroke="currentColor"
        strokeWidth="4.5"
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
    playSfx("select");
    return () => {
      trigger?.focus();
    };
  }, []);
  const dismiss = () => {
    if (allowNavigation(ref.current!)) {
      playSfx("back");
      close();
    }
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
          <p className="eyebrow">PORTCULLIS // SYSTEM LINK TERMINAL</p>
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
    if (open) {
      drawer.current?.showModal();
      playSfx("select");
    } else if (drawer.current?.open) {
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
          playSfx("select");
          navigate("services");
          setOpen(false);
        }}
      >
        <Brand />
      </a>
      <p className="eyebrow">YOUR COMMUNITY. CONNECTED.</p>
      <div className="lobby-beacon" aria-hidden="true">
        <span className="beacon-dot" />
        <span>SYSTEM LINK // LIVE</span>
      </div>
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
                  onMouseEnter={() => playSfx("tick")}
                  onClick={() => {
                    if (!allowNavigation()) return;
                    playSfx("select");
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
            playSfx("select");
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
          playSfx("back");
          setOpen(false);
        }}
      >
        <button
          className="drawer-close"
          onClick={() => {
            playSfx("back");
            setOpen(false);
          }}
          aria-label="Close navigation"
        >
          <Icon name="close" />
        </button>
        {content}
      </dialog>
    </>
  );
}
