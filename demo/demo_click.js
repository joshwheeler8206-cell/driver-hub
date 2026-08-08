(function () {
  var params = new URLSearchParams(location.search);
  var tab = params.get('view');
  if (!tab) return;
  if (tab === 'drivers') {
    var dv = setInterval(function () {
      if (typeof renderRosterView === 'function') { renderRosterView(); clearInterval(dv); }
    }, 250);
    return;
  }
  var clicked = false;
  var sub = params.get('sub');
  var tries = 0;
  var iv = setInterval(function () {
    tries++;
    var t = document.querySelector('.tab[data-view="' + tab + '"]');
    if (t) {
      t.click();
      if (sub) {
        setTimeout(function () {
          var st = Array.prototype.slice.call(document.querySelectorAll('.subtab')).find(function (b) {
            return b.textContent.trim().toLowerCase() === sub.toLowerCase();
          });
          if (st) st.click();
        }, 400);
      }
      clicked = true;
      clearInterval(iv);
    } else if (tries > 40) {
      clearInterval(iv);
    }
  }, 250);
})();
