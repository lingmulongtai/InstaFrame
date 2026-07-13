module.exports = async function globalSetup() {
  await import('../../scripts/prepare-vendor.mjs');
  await import('../../scripts/prepare-site.mjs');
  const { startStaticServer } = await import('../../scripts/serve-site.mjs');
  const server = await startStaticServer();

  return async () => {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    await new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    });
  };
};
