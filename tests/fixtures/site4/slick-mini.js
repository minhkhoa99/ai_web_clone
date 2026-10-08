// Fixture stand-in for jQuery + Slick (E2 R10): $(el).slick('getSlick').options and the slick DOM classes.
window.jQuery = function (el) { return { slick: function (cmd) { return cmd === "getSlick" && el.__slick ? { options: el.__slick } : undefined; } }; };
window.miniSlick = function (el, options) { el.__slick = options; el.classList.add("slick-slider", "slick-initialized"); };
