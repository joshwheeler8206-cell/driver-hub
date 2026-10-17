(function () {
  var params = new URLSearchParams(location.search);
  var tab = params.get('view');
  var sub = params.get('sub');
  var traineeRef = params.get('trainee');

  // ?trainee=<id|name> opens a trainee's detail (curriculum, process card,
  // check-off initials table, digital sign-off) so the demo can show the
  // newest training UI without manual clicking. Works with or without ?view.
  function openTraineeWhenReady() {
    var tries = 0;
    var iv = setInterval(function () {
      tries++;
      var found = null;
      try {
        if (typeof trainees !== 'undefined' && trainees) {
          var ref = String(traineeRef).toLowerCase();
          found = trainees.filter(function (x) {
            return String(x.id) === String(traineeRef) || (x.name || '').toLowerCase() === ref;
          })[0] || null;
        }
      } catch (e) { /* trainees not declared yet (TDZ) */ }
      if (found && typeof openTrainee === 'function') {
        try { openTrainee(found.id); } catch (e) {}
        clearInterval(iv);
      } else if (tries > 40) {
        clearInterval(iv);
      }
    }, 250);
  }

  if (tab === 'drivers') {
    var dv = setInterval(function () {
      if (typeof renderRosterView === 'function') { renderRosterView(); clearInterval(dv); }
    }, 250);
    if (traineeRef) openTraineeWhenReady();
    return;
  }

  if (tab) {
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
        clearInterval(iv);
      } else if (tries > 40) {
        clearInterval(iv);
      }
    }, 250);
  }

  if (traineeRef) {
    // Let the tab + subtab render first, then open the detail.
    setTimeout(openTraineeWhenReady, tab ? 900 : 0);
  }
})();
