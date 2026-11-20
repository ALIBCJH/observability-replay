/**
 * Play the entrance animations once. The rules in motion.css apply while
 * <html> has the class "enter"; it is removed when they have finished, so
 * redrawing part of the page later does not replay them.
 */
let played = false;
export function playEntrance(): void {
  if (played) return;
  played = true;
  const root = document.documentElement;
  root.classList.add("enter");
  setTimeout(() => root.classList.remove("enter"), 3500);
}
