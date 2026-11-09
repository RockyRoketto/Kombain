// ---------- лёгкие анимации: выделение вкладки переезжает ----------
// Остальные анимации только в CSS (раздел «лёгкие анимации» в style.css).
// Вкладки по-прежнему переключают класс on, поэтому про плашку они ничего не знают.
function glideTabs(box, sel) {
  const pill = document.createElement('i');
  pill.className = 'glide';
  box.prepend(pill);
  box.classList.add('glided');
  const place = () => {
    const b = box.querySelector(sel + '.on');
    pill.style.opacity = b ? 1 : 0;
    if (!b || !b.offsetWidth) return;       // вкладка скрыта: встанет на место, когда появится
    pill.style.transform = `translate(${b.offsetLeft}px,${b.offsetTop}px)`;
    pill.style.width = b.offsetWidth + 'px';
    pill.style.height = b.offsetHeight + 'px';
  };
  // новый размер (окно, язык, показ вкладки) — сразу на место, переезд только при смене вкладки
  const jump = () => {
    pill.style.transition = 'none';
    place();
    pill.offsetWidth;
    pill.style.transition = '';
  };
  new MutationObserver(place).observe(box, {subtree: true, attributes: true, attributeFilter: ['class']});
  new ResizeObserver(jump).observe(box);
  jump();
}
glideTabs($('tabs'), '.tab');

