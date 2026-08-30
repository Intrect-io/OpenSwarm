const entriesBody = document.querySelector('#entries');
const breadcrumbs = document.querySelector('#breadcrumbs');
const upButton = document.querySelector('#up');
const refreshButton = document.querySelector('#refresh');
const fileInput = document.querySelector('#file');
const fileLabel = document.querySelector('#file-label');
const overwriteInput = document.querySelector('#overwrite');
const uploadButton = document.querySelector('#upload');
const uploadDirectory = document.querySelector('#upload-directory');
const status = document.querySelector('#status');
const webTokenInput = document.querySelector('#web-token');
const saveTokenButton = document.querySelector('#save-token');
const clearTokenButton = document.querySelector('#clear-token');

const TOKEN_KEY = 'openswarm.webToken';

let currentPath = '';

function parts(path) {
  return path.split('/').filter(Boolean);
}

function joinPath(directory, name) {
  return [...parts(directory), name].join('/');
}

function formatBytes(size) {
  if (size < 1024) return `${size} B`;
  const units = ['KiB', 'MiB', 'GiB'];
  let value = size / 1024;
  let unit = units[0];
  for (let i = 1; i < units.length && value >= 1024; i += 1) {
    value /= 1024;
    unit = units[i];
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${unit}`;
}

async function api(url, options) {
  const headers = new Headers(options?.headers);
  const token = sessionStorage.getItem(TOKEN_KEY);
  if (token) headers.set('X-OpenSwarm-Token', token);
  const response = await fetch(url, { ...options, headers });
  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    try { message = (await response.json()).error || message; } catch { /* non-JSON */ }
    throw new Error(message);
  }
  return response;
}

function setStatus(message, kind = '') {
  status.className = `status${kind ? ` ${kind}` : ''}`;
  status.textContent = message;
}

function renderBreadcrumbs() {
  breadcrumbs.replaceChildren();
  const root = document.createElement('button');
  root.type = 'button';
  root.textContent = 'warehouse';
  root.addEventListener('click', () => loadTree(''));
  breadcrumbs.append(root);
  const segments = parts(currentPath);
  segments.forEach((segment, index) => {
    const divider = document.createElement('span');
    divider.textContent = '/';
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = segment;
    button.addEventListener('click', () => loadTree(segments.slice(0, index + 1).join('/')));
    breadcrumbs.append(divider, button);
  });
  upButton.disabled = segments.length === 0;
  uploadDirectory.textContent = `/${currentPath}`;
}

function downloadButton(path, name) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'download';
  button.textContent = '내려받기';
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      const response = await api(`/api/warehouse/file?path=${encodeURIComponent(path)}`);
      const objectUrl = URL.createObjectURL(await response.blob());
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = name;
      link.click();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
    } catch (error) {
      setStatus(error.message, 'error');
    } finally {
      button.disabled = false;
    }
  });
  return button;
}

function renderEntries(entries) {
  entriesBody.replaceChildren();
  if (!entries.length) {
    const row = document.createElement('tr');
    row.innerHTML = '<td colspan="5" class="empty">빈 폴더입니다.</td>';
    entriesBody.append(row);
    return;
  }
  for (const entry of entries) {
    const row = document.createElement('tr');
    const nameCell = document.createElement('td');
    const name = document.createElement(entry.type === 'directory' ? 'button' : 'span');
    name.className = 'file-name';
    name.textContent = `${entry.type === 'directory' ? '📁' : entry.type === 'symlink' ? '🔗' : '📄'} ${entry.name}`;
    if (entry.type === 'directory') name.addEventListener('click', () => loadTree(joinPath(currentPath, entry.name)));
    nameCell.append(name);
    const typeCell = document.createElement('td');
    typeCell.textContent = entry.type;
    const sizeCell = document.createElement('td');
    sizeCell.textContent = entry.type === 'directory' ? '—' : formatBytes(entry.size);
    const modifiedCell = document.createElement('td');
    modifiedCell.textContent = new Date(entry.mtime).toLocaleString('ko-KR');
    const actionCell = document.createElement('td');
    if (entry.type !== 'directory') actionCell.append(downloadButton(joinPath(currentPath, entry.name), entry.name));
    row.append(nameCell, typeCell, sizeCell, modifiedCell, actionCell);
    entriesBody.append(row);
  }
}

async function loadTree(path) {
  setStatus('');
  try {
    const response = await api(`/api/warehouse/tree?path=${encodeURIComponent(path)}`);
    const payload = await response.json();
    currentPath = path;
    renderBreadcrumbs();
    renderEntries(payload.entries);
  } catch (error) {
    entriesBody.innerHTML = `<tr><td colspan="5" class="empty error"></td></tr>`;
    entriesBody.querySelector('td').textContent = error.message;
  }
}

fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  fileLabel.textContent = file ? `${file.name} · ${formatBytes(file.size)}` : '파일을 선택하세요';
  uploadButton.disabled = !file;
});

uploadButton.addEventListener('click', async () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  uploadButton.disabled = true;
  setStatus('업로드 중…');
  const target = joinPath(currentPath, file.name);
  try {
    const overwrite = overwriteInput.checked ? '&overwrite=true' : '';
    await api(`/api/warehouse/file?path=${encodeURIComponent(target)}${overwrite}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: file,
    });
    setStatus(`${file.name} 업로드 완료`, 'success');
    fileInput.value = '';
    fileLabel.textContent = '파일을 선택하세요';
    overwriteInput.checked = false;
    await loadTree(currentPath);
  } catch (error) {
    setStatus(error.message, 'error');
  } finally {
    uploadButton.disabled = !fileInput.files?.length;
  }
});

saveTokenButton.addEventListener('click', () => {
  const token = webTokenInput.value.trim();
  if (token) sessionStorage.setItem(TOKEN_KEY, token);
  else sessionStorage.removeItem(TOKEN_KEY);
  webTokenInput.value = '';
  setStatus(token ? '이 탭에 웹 토큰을 적용했습니다.' : '웹 토큰을 지웠습니다.', 'success');
  loadTree(currentPath);
});

clearTokenButton.addEventListener('click', () => {
  sessionStorage.removeItem(TOKEN_KEY);
  webTokenInput.value = '';
  setStatus('이 탭의 웹 토큰을 지웠습니다.');
  loadTree(currentPath);
});

upButton.addEventListener('click', () => loadTree(parts(currentPath).slice(0, -1).join('/')));
refreshButton.addEventListener('click', () => loadTree(currentPath));
loadTree('');
