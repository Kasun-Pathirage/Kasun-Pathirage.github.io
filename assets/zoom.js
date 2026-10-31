/* Click any photo on a project page to view it full size. Esc, click or the × closes it. */
(function () {
  'use strict';
  var css = document.createElement('style');
  css.textContent =
    '.container figure img{cursor:zoom-in}' +
    '.container a figure img,.container a img{cursor:pointer}' +
    '#__zoom{position:fixed;inset:0;z-index:2147482000;background:rgba(10,10,10,.9);display:none;' +
    'flex-direction:column;align-items:center;justify-content:center;padding:24px;cursor:zoom-out}' +
    '#__zoom.on{display:flex}' +
    '#__zoom img{max-width:100%;max-height:calc(100vh - 110px);object-fit:contain;border-radius:6px;box-shadow:0 8px 40px rgba(0,0,0,.5)}' +
    '#__zoom p{color:#eee;font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;max-width:900px;text-align:center;margin:14px 0 0}' +
    '#__zoom button{position:absolute;top:12px;right:16px;background:none;border:0;color:#fff;font-size:34px;line-height:1;cursor:pointer}';
  document.head.appendChild(css);

  var box = document.createElement('div');
  box.id = '__zoom';
  box.setAttribute('data-ed-ui', '');
  box.innerHTML = '<button aria-label="Close">×</button><img alt=""><p></p>';
  document.body.appendChild(box);
  var big = box.querySelector('img'), cap = box.querySelector('p');

  function close() { box.classList.remove('on'); big.removeAttribute('src'); }
  box.addEventListener('click', close);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });

  document.addEventListener('click', function (e) {
    if (document.body.hasAttribute('data-ed-on')) return; // edit mode owns clicks
    var img = e.target.closest && e.target.closest('.container figure img');
    if (!img || img.closest('a')) return;               // video thumbnails keep their links
    e.preventDefault();
    var fig = img.closest('figure'), fc = fig && fig.querySelector('figcaption');
    big.src = img.currentSrc || img.src;
    big.alt = img.alt || '';
    cap.textContent = fc ? fc.textContent.trim() : '';
    cap.style.display = cap.textContent ? '' : 'none';
    box.classList.add('on');
  });
})();
