/**
 * An optional companion that peeks over the bottom edge of the table, watches where the
 * cards go and cheers the player on. Purely decorative: it never blocks a card.
 */

export type BunnyEvent =
  | 'start'
  | 'move'
  | 'reveal'
  | 'suit'
  | 'complete'
  | 'deal'
  | 'undo'
  | 'invalid'
  | 'stuck'
  | 'win';

const LINES: Record<BunnyEvent | 'tap' | 'idle', string[]> = {
  start: ['Ooh, a fresh deal!', 'Let’s play!', 'I’ve got a good feeling about this one', 'Shuffle shuffle… go!'],
  move: ['Nice move', 'Hmm, clever', 'Good thinking!', 'I see what you did there'],
  reveal: ['Ooh, a new card!', 'Peekaboo!', 'What’s under there?', 'Nice, one less hidden!'],
  suit: ['Same suit, so tidy!', 'Look at that run grow', 'Building nicely!', 'Matchy matchy!'],
  complete: ['A whole run! Yay!', 'King to Ace, wow!', 'Hop hop hooray!', 'That’s one stack done!'],
  deal: ['Here come more cards', 'Fresh row!', 'Ooh, new options'],
  undo: ['That’s okay!', 'Take it back, no problem', 'Let’s try another way', 'Oops happens!'],
  invalid: ['Hmm, not there…', 'Almost!', 'That one can’t go there'],
  stuck: ['Oh no… we’re stuck', 'Want to try undoing a few?', 'Tough one. Maybe a new deal?'],
  win: ['YOU DID IT!', 'Amazing! I knew you could!', 'Champion of the felt!', 'Hop hop HOORAY!'],
  tap: ['Hehe, that tickles!', 'You’re doing great!', 'I believe in you!', 'Carrot break? 🥕', '*happy wiggle*', 'Boop!'],
  idle: ['Take your time 🥕', 'Psst… Hint can help', 'Thinking hard? Me too', '*yawn*… still here!'],
};

/** How often each event gets a comment; the rest just get a look and an ear twitch. */
const CHANCE: Record<BunnyEvent, number> = {
  start: 0.7,
  move: 0.08,
  reveal: 0.35,
  suit: 0.3,
  complete: 1,
  deal: 0.3,
  undo: 0.45,
  invalid: 0.4,
  stuck: 1,
  win: 1,
};

/** Events that are always worth saying, even right after another comment. */
const IMPORTANT = new Set<string>(['complete', 'stuck', 'win', 'tap']);

const IDLE_MS = 45_000;
const QUIET_MS = 7_000;

const SVG = `
<svg viewBox="0 0 120 116" aria-hidden="true">
  <g class="ear ear-l">
    <ellipse cx="44" cy="36" rx="12.5" ry="31" fill="#fbf6ee" stroke="#3b2f27" stroke-width="3"/>
    <ellipse cx="44" cy="40" rx="6" ry="21" fill="#f5b3c1"/>
  </g>
  <g class="ear ear-r">
    <ellipse cx="78" cy="36" rx="12.5" ry="31" fill="#fbf6ee" stroke="#3b2f27" stroke-width="3"/>
    <ellipse cx="78" cy="40" rx="6" ry="21" fill="#f5b3c1"/>
  </g>
  <ellipse cx="61" cy="84" rx="41" ry="33" fill="#fbf6ee" stroke="#3b2f27" stroke-width="3"/>
  <ellipse cx="37" cy="93" rx="7.5" ry="4.5" fill="#f5a3b5" opacity="0.65"/>
  <ellipse cx="85" cy="93" rx="7.5" ry="4.5" fill="#f5a3b5" opacity="0.65"/>
  <g class="eyes">
    <g class="gaze">
      <ellipse cx="47" cy="80" rx="5.6" ry="6.6" fill="#2b211b"/>
      <circle cx="49" cy="77.6" r="1.9" fill="#fff"/>
      <ellipse cx="75" cy="80" rx="5.6" ry="6.6" fill="#2b211b"/>
      <circle cx="77" cy="77.6" r="1.9" fill="#fff"/>
    </g>
  </g>
  <path d="M57.5 89.5 h7 l-3.5 4 z" fill="#ef8ea3" stroke="#3b2f27" stroke-width="1.2" stroke-linejoin="round"/>
  <path class="mouth" d="M55 96 q3 3.5 6 0 q3 3.5 6 0" fill="none" stroke="#3b2f27" stroke-width="2" stroke-linecap="round"/>
  <ellipse cx="38" cy="114" rx="13" ry="8" fill="#fbf6ee" stroke="#3b2f27" stroke-width="3"/>
  <ellipse cx="84" cy="114" rx="13" ry="8" fill="#fbf6ee" stroke="#3b2f27" stroke-width="3"/>
</svg>`;

export class Bunny {
  private el: HTMLElement;
  private bubble: HTMLElement;
  private gaze: SVGGElement;
  private enabled = false;
  private lastSpoke = 0;
  private bubbleTimer = 0;
  private idleTimer = 0;
  private blinkTimer = 0;
  private moodTimer = 0;
  private lastLine = '';

  constructor(host: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'bunny';
    this.el.setAttribute('role', 'button');
    this.el.setAttribute('aria-label', 'Bunny companion');
    this.el.innerHTML = `<div class="bunny-bubble" role="status" aria-live="polite"></div><div class="bunny-body">${SVG}</div>`;
    host.appendChild(this.el);
    this.bubble = this.el.querySelector('.bunny-bubble')!;
    this.gaze = this.el.querySelector('.gaze')!;
    // Its own taps must not start anything on the table underneath.
    this.el.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      this.poke();
    });
  }

  setEnabled(on: boolean) {
    if (on === this.enabled) return;
    this.enabled = on;
    this.el.classList.toggle('on', on);
    clearTimeout(this.blinkTimer);
    clearTimeout(this.idleTimer);
    if (on) {
      this.scheduleBlink();
      this.resetIdle();
    } else {
      this.hideBubble();
    }
  }

  /** React to something on the table. `x` is where it happened, 0–1 across the board. */
  react(event: BunnyEvent, x?: number) {
    if (!this.enabled) return;
    this.resetIdle();
    if (x !== undefined) this.look(x);
    const mood = event === 'stuck' ? 'sad' : event === 'win' ? 'party' : event === 'complete' ? 'hop' : event === 'invalid' ? '' : 'twitch';
    if (mood) this.setMood(mood, event === 'win' ? 6000 : 900);
    if (Math.random() < CHANCE[event]) this.say(event);
  }

  private poke() {
    if (!this.enabled) return;
    this.resetIdle();
    this.setMood('hop', 700);
    this.say('tap');
  }

  private say(kind: keyof typeof LINES) {
    const now = performance.now();
    if (!IMPORTANT.has(kind) && now - this.lastSpoke < QUIET_MS) return;
    const pool = LINES[kind].filter((l) => l !== this.lastLine);
    const line = pool[Math.floor(Math.random() * pool.length)];
    this.lastLine = line;
    this.lastSpoke = now;
    this.bubble.textContent = line;
    this.bubble.classList.add('show');
    clearTimeout(this.bubbleTimer);
    this.bubbleTimer = window.setTimeout(() => this.hideBubble(), kind === 'win' ? 5000 : 2600);
  }

  private hideBubble() {
    this.bubble.classList.remove('show');
  }

  private setMood(mood: string, ms: number) {
    this.el.classList.remove('hop', 'twitch', 'sad', 'party');
    void this.el.offsetWidth; // restart the animation
    this.el.classList.add(mood);
    clearTimeout(this.moodTimer);
    this.moodTimer = window.setTimeout(() => this.el.classList.remove(mood), ms);
  }

  /** Point the eyes toward where the action is, then drift back to the player. */
  private look(x: number) {
    const rect = this.el.getBoundingClientRect();
    const host = this.el.parentElement!.getBoundingClientRect();
    const target = host.left + x * host.width;
    const dx = Math.max(-1, Math.min(1, (target - (rect.left + rect.width / 2)) / (host.width / 2)));
    this.gaze.style.transform = `translate(${dx * 3.5}px, -2.5px)`;
    window.setTimeout(() => (this.gaze.style.transform = ''), 1600);
  }

  private scheduleBlink() {
    this.blinkTimer = window.setTimeout(
      () => {
        this.el.classList.add('blink');
        window.setTimeout(() => this.el.classList.remove('blink'), 140);
        if (this.enabled) this.scheduleBlink();
      },
      2500 + Math.random() * 4000,
    );
  }

  private resetIdle() {
    clearTimeout(this.idleTimer);
    this.idleTimer = window.setTimeout(() => {
      if (!this.enabled || document.hidden) return;
      this.setMood('twitch', 900);
      this.say('idle');
    }, IDLE_MS);
  }
}
