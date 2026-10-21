let sdkPromise;
export async function pickNas(base, options = {}) {
  if (!sdkPromise) {
    const path = base + '/static/vendor/trim-web-app.js';
    sdkPromise = import(path).then(module => new module.TrimApp()).catch(error => { sdkPromise = null; throw error; });
  }
  const sdk = await sdkPromise;
  const result = await sdk.pickUserFile({ directory: true, title: '选择 NAS 目录', okText: '选择', sidebarGroup: ['myFiles', 'otherShare', 'favorites'], ...options });
  return result?.data?.[0];
}
