// Modo noche: pantalla completamente negra mientras la app sigue trabajando en primer plano.
// En pantallas OLED los pixeles negros están apagados: casi no gasta batería ni marca la pantalla.
// El texto es tenue y cambia de lugar cada 40 s para no dejar marca. Tocar en cualquier parte sale.
import { $ } from './util.js';

export function createNight(getText) { // getText(): texto de avance que se muestra tenue
  const box = $('night'), text = $('night-text'), hint = $('night-hint');
  let timer = 0, mover = 0, hintTimer = 0;

  const move = () => {
    text.style.left = `${8 + Math.random() * 50}%`;
    text.style.top = `${10 + Math.random() * 70}%`;
  };
  const tick = () => { text.textContent = getText(); };

  function enter() {
    box.hidden = false;
    hint.hidden = false;
    tick(); move();
    timer = setInterval(tick, 2000);
    mover = setInterval(move, 40000);
    hintTimer = setTimeout(() => { hint.hidden = true; }, 4000);
    document.documentElement.requestFullscreen?.({ navigationUI: 'hide' }).catch(() => {});
  }
  function exit() {
    if (box.hidden) return;
    box.hidden = true;
    clearInterval(timer); clearInterval(mover); clearTimeout(hintTimer);
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  }
  box.addEventListener('click', exit);
  return { enter, exit, get active() { return !box.hidden; }, refresh: tick };
}
