// Sevari enquiry form helper. Put next to a <form data-sevari-form> on a business's own website.
// Sends the form to Sevari as one enquiry, with an id so a double-click can't send it twice.
// No cookies, no tracking, nothing loaded from anywhere else.
(function () {
  'use strict';
  var forms = document.querySelectorAll('form[data-sevari-form]');
  Array.prototype.forEach.call(forms, function (form) {
    var status = form.querySelector('[data-sevari-status]');
    var say = function (t) { if (status) status.textContent = t; };
    var id = null;
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var f = new FormData(form);
      var body = { submission_id: id || (id = crypto.randomUUID()), message: String(f.get('message') || '').trim() };
      ['name', 'email', 'phone', 'subject', 'company_website'].forEach(function (k) {
        var v = String(f.get(k) || '').trim();
        if (v) body[k] = v;
      });
      if (!body.message) { say('Please tell us how we can help.'); return; }
      if (!body.email && !body.phone) { say('Please give an email address or a phone number so we can reply.'); return; }
      var button = form.querySelector('button[type="submit"]');
      if (button) button.disabled = true;
      say('Sending…');
      fetch(form.getAttribute('data-sevari-endpoint'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
        .then(function (res) {
          if (res.status === 202) { form.reset(); id = null; say('Thank you. Your message has been sent, and we will reply soon.'); }
          else if (res.status === 429) say('Too many messages just now. Please try again in a minute.');
          else say('Sorry, that did not send. Please check your details and try again.');
        })
        .catch(function () { say('Sorry, that did not send. Please check your connection and try again.'); })
        .then(function () { if (button) button.disabled = false; });
    });
  });
})();
