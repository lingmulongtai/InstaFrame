/**
 * Public runtime configuration. Browser tokens are visible by design. Protect
 * the Mapbox token in the Mapbox dashboard with matching URL restrictions.
 */
window.INSTAFRAME_CONFIG = Object.freeze({
  mapbox: Object.freeze({
    publicToken: 'pk.eyJ1IjoibGluZ211bG9uZ3RhaSIsImEiOiJjbW53cHp3eHoxbDZhMnBtbzB3b3huemZwIn0.kX4B2BumC8txS9rZw41a-Q',
    allowedOrigins: Object.freeze([
      'https://lingmulongtai.github.io',
    ]),
    dailyRequestLimitPerDevice: 100,
    monthlyRequestLimitPerDevice: 1000,
  }),
});
