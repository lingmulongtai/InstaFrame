/**
 * Public runtime configuration. Keep publicToken empty until a dedicated token
 * has URL restrictions configured in the Mapbox dashboard.
 */
window.INSTAFRAME_CONFIG = Object.freeze({
  mapbox: Object.freeze({
    publicToken: '',
    allowedOrigins: Object.freeze([
      'https://lingmulongtai.github.io',
    ]),
    dailyRequestLimitPerDevice: 100,
    monthlyRequestLimitPerDevice: 1000,
  }),
});
