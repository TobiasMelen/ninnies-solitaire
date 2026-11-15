/** Add a class for a moment (restarting its animation if it's already running). */
export function flash(el: HTMLElement, cls: string, ms = 1600) {
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
  window.setTimeout(() => el.classList.remove(cls), ms);
}
