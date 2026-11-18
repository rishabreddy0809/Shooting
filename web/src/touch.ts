import type { Input } from "./game";
import type { HUDSnapshot } from "./hud";

/** True on phones and tablets (iPadOS reports itself as a Mac, but with touch points). */
export function isTouchDevice(): boolean {
  return navigator.maxTouchPoints > 1 || matchMedia("(pointer: coarse)").matches;
}

/** Swipe-to-look speed relative to the mouse: a finger travels less than a mouse does. */
const LOOK_SCALE = 1.6;
/** Joystick radius in CSS pixels. */
const STICK_R = 62;

type Role =
  | { kind: "move"; ox: number; oy: number }
  | { kind: "look"; x: number; y: number }
  | { kind: "fire"; x: number; y: number; el: HTMLElement }
  | { kind: "hold"; code: string; el: HTMLElement }
  | { kind: "tap"; el: HTMLElement };

interface Buttons {
  slotAt(x: number, y: number): number | null;
  onPause(): void;
}

/**
 * On-screen controls for touch screens. Left half: a floating joystick (push it all the way
 * forward to sprint). Right half: drag to look. Buttons feed the same Input the keyboard does,
 * so the game itself doesn't know the difference.
 */
export class TouchControls {
  readonly root: HTMLDivElement;
  private roles = new Map<number, Role>();
  private stickBase: HTMLDivElement;
  private stickKnob: HTMLDivElement;
  private btn: Record<string, HTMLElement> = {};
  private snap: HUDSnapshot | null = null;
  private moveKeys = new Set<string>();

  constructor(private input: Input, private host: Buttons) {
    const root = document.createElement("div");
    root.id = "touch";
    root.className = "hidden";
    root.innerHTML = `
      <div class="stick-base"><div class="stick-knob"></div></div>
      <div class="tb pause" data-tap="pause">❚❚</div>
      <div class="tb gfx" data-tap="KeyG">GFX</div>
      <div class="tb fire" data-fire>FIRE</div>
      <div class="tb aim" data-tap="KeyQ">AIM</div>
      <div class="tb jump" data-tap="Space">JUMP</div>
      <div class="tb crouch" data-tap="KeyC">CROUCH</div>
      <div class="tb reload" data-tap="KeyR">RELOAD</div>
      <div class="tb swap" data-tap="swap">SWAP</div>
      <div class="tb use" data-tap="KeyE">PICK UP</div>
      <div class="tb breath" data-hold="ShiftLeft">HOLD<br>BREATH</div>
      <div class="tb zin" data-tap="Equal">＋</div>
      <div class="tb zout" data-tap="Minus">−</div>
      <div class="tb zup" data-tap="ArrowUp">ZERO ▲</div>
      <div class="tb zdown" data-tap="ArrowDown">ZERO ▼</div>`;
    this.root = root;
    this.stickBase = root.querySelector(".stick-base")!;
    this.stickKnob = root.querySelector(".stick-knob")!;
    for (const el of root.querySelectorAll<HTMLElement>(".tb")) this.btn[el.classList[1]] = el;

    root.addEventListener("pointerdown", (e) => this.down(e));
    root.addEventListener("pointermove", (e) => this.move(e));
    root.addEventListener("pointerup", (e) => this.up(e));
    root.addEventListener("pointercancel", (e) => this.up(e));
    root.addEventListener("contextmenu", (e) => e.preventDefault());
    // Stop the browser turning a tap into a click: pausing shows the card under the finger,
    // and that click would resume straight away.
    for (const ev of ["touchstart", "touchend"] as const) root.addEventListener(ev, (e) => e.preventDefault(), { passive: false });
  }

  show(on: boolean) {
    this.root.classList.toggle("hidden", !on);
    if (!on) this.reset();
  }

  /** Lets go of everything, e.g. when the game pauses with fingers still down. */
  reset() {
    for (const [id] of this.roles) this.release(id);
    this.roles.clear();
  }

  /** Shows only the buttons that do something right now. */
  sync(s: HUDSnapshot) {
    this.snap = s;
    const aiming = s.ads > 0.5;
    this.btn.aim.classList.toggle("on", aiming);
    this.btn.crouch.classList.toggle("on", s.crouched);
    this.btn.use.classList.toggle("off", !s.pickupPrompt);
    this.btn.breath.classList.toggle("off", !aiming);
    this.btn.breath.classList.toggle("on", s.holding);
    for (const k of ["zin", "zout"]) this.btn[k].classList.toggle("off", !s.scoped);
    for (const k of ["zup", "zdown"]) this.btn[k].classList.toggle("off", !s.scoped);
    this.btn.swap.classList.toggle("off", s.slots.filter(Boolean).length < 2);
  }

  private down(e: PointerEvent) {
    e.preventDefault();
    this.root.setPointerCapture(e.pointerId);
    const el = (e.target as HTMLElement).closest<HTMLElement>(".tb");
    if (el && !el.classList.contains("off")) {
      el.classList.add("pressed");
      if (el.dataset.fire !== undefined) {
        this.input.fireDown = true;
        this.input.firePressed = true;
        this.roles.set(e.pointerId, { kind: "fire", x: e.clientX, y: e.clientY, el });
      } else if (el.dataset.hold) {
        this.input.keys.add(el.dataset.hold);
        this.roles.set(e.pointerId, { kind: "hold", code: el.dataset.hold, el });
      } else {
        this.tap(el.dataset.tap!);
        this.roles.set(e.pointerId, { kind: "tap", el });
      }
      return;
    }
    const slot = this.host.slotAt(e.clientX, e.clientY);
    if (slot !== null) {
      this.press(`Digit${slot + 1}`);
      this.roles.set(e.pointerId, { kind: "look", x: e.clientX, y: e.clientY });
      return;
    }
    if (e.clientX < window.innerWidth * 0.42 && ![...this.roles.values()].some((r) => r.kind === "move")) {
      this.roles.set(e.pointerId, { kind: "move", ox: e.clientX, oy: e.clientY });
      this.stickBase.style.transform = `translate(${e.clientX - STICK_R}px, ${e.clientY - STICK_R}px)`;
      this.stickKnob.style.transform = "translate(0px, 0px)";
      this.stickBase.classList.add("active");
    } else {
      this.roles.set(e.pointerId, { kind: "look", x: e.clientX, y: e.clientY });
    }
  }

  private move(e: PointerEvent) {
    const r = this.roles.get(e.pointerId);
    if (!r) return;
    e.preventDefault();
    if (r.kind === "look" || r.kind === "fire") {
      this.input.mouseDX += (e.clientX - r.x) * LOOK_SCALE;
      this.input.mouseDY += (e.clientY - r.y) * LOOK_SCALE;
      r.x = e.clientX;
      r.y = e.clientY;
    } else if (r.kind === "move") {
      let dx = e.clientX - r.ox, dy = e.clientY - r.oy;
      const d = Math.hypot(dx, dy);
      if (d > STICK_R) { dx *= STICK_R / d; dy *= STICK_R / d; }
      this.stickKnob.style.transform = `translate(${dx}px, ${dy}px)`;
      const nx = dx / STICK_R, ny = dy / STICK_R;
      const want = new Set<string>();
      if (ny < -0.35) want.add("KeyW");
      if (ny > 0.35) want.add("KeyS");
      if (nx < -0.35) want.add("KeyA");
      if (nx > 0.35) want.add("KeyD");
      // Stick pinned forward (or dragged well past the ring) sprints.
      if (ny < -0.85 && Math.abs(nx) < 0.5) want.add("ShiftRight");
      this.setMoveKeys(want);
    }
  }

  private up(e: PointerEvent) {
    if (!this.roles.has(e.pointerId)) return;
    this.release(e.pointerId);
    this.roles.delete(e.pointerId);
  }

  private release(id: number) {
    const r = this.roles.get(id);
    if (!r) return;
    if (r.kind === "move") {
      this.setMoveKeys(new Set());
      this.stickBase.classList.remove("active");
    } else if (r.kind === "fire") {
      if (![...this.roles].some(([k, o]) => k !== id && o.kind === "fire")) this.input.fireDown = false;
      r.el.classList.remove("pressed");
    } else if (r.kind === "hold") {
      this.input.keys.delete(r.code);
      r.el.classList.remove("pressed");
    } else if (r.kind === "tap") {
      r.el.classList.remove("pressed");
    }
  }

  private setMoveKeys(want: Set<string>) {
    for (const k of this.moveKeys) if (!want.has(k)) this.input.keys.delete(k);
    for (const k of want) this.input.keys.add(k);
    this.moveKeys = want;
  }

  /** A one-frame key press, as if the key went down and straight back up. */
  private press(code: string) {
    this.input.pressed.add(code);
  }

  private tap(action: string) {
    if (action === "pause") return this.host.onPause();
    if (action === "swap") {
      const s = this.snap;
      if (!s) return;
      for (let i = 1; i <= s.slots.length; i++) {
        const j = (s.currentSlot + i) % s.slots.length;
        if (s.slots[j]) return this.press(`Digit${j + 1}`);
      }
      return;
    }
    this.press(action);
  }
}
