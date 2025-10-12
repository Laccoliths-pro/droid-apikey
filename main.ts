// main.ts
import { serve } from "https://deno.land/std@0.182.0/http/server.ts";
import { format } from "https://deno.land/std@0.182.0/datetime/mod.ts";

// ==================== Type Definitions ====================

interface ApiKey {
  id: string;
  key: string;
}

interface ApiUsageData {
  id: string;
  key: string;
  startDate: string;
  endDate: string;
  orgTotalTokensUsed: number;
  totalAllowance: number;
  usedRatio: number;
}

interface ApiErrorData {
  id: string;
  key: string;
  error: string;
}

type ApiKeyResult = ApiUsageData | ApiErrorData;

interface UsageTotals {
  total_orgTotalTokensUsed: number;
  total_totalAllowance: number;
  totalRemaining: number;
}

interface AggregatedResponse {
  update_time: string;
  total_count: number;
  totals: UsageTotals;
  data: ApiKeyResult[];
}

interface ApiResponse {
  usage: {
    startDate: number;
    endDate: number;
    standard: {
      orgTotalTokensUsed: number;
      totalAllowance: number;
      usedRatio: number;
    };
  };
}

interface BatchImportResult {
  success: boolean;
  added: number;
  skipped: number;
  errors?: string[];
}

// ==================== Configuration ====================

const CONFIG = {
  PORT: 8000,
  API_ENDPOINT: 'https://app.factory.ai/api/organization/members/chat-usage',
  USER_AGENT: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  TIMEZONE_OFFSET_HOURS: 8, // Beijing time
  KEY_MASK_PREFIX_LENGTH: 4,
  KEY_MASK_SUFFIX_LENGTH: 4,
} as const;

// ==================== Database Initialization ====================

const kv = await Deno.openKv();

// ==================== Database Operations ====================

async function getAllKeys(): Promise<ApiKey[]> {
  const keys: ApiKey[] = [];
  const entries = kv.list<string>({ prefix: ["api_keys"] });

  for await (const entry of entries) {
    const id = entry.key[1] as string;
    keys.push({ id, key: entry.value });
  }

  return keys;
}

async function addKey(id: string, key: string): Promise<void> {
  await kv.set(["api_keys", id], key);
}

async function deleteKey(id: string): Promise<void> {
  await kv.delete(["api_keys", id]);
}

async function keyExists(id: string): Promise<boolean> {
  const result = await kv.get(["api_keys", id]);
  return result.value !== null;
}

// ==================== Utility Functions ====================

function maskApiKey(key: string): string {
  if (key.length <= CONFIG.KEY_MASK_PREFIX_LENGTH + CONFIG.KEY_MASK_SUFFIX_LENGTH) {
    return `${key.substring(0, CONFIG.KEY_MASK_PREFIX_LENGTH)}...`;
  }
  return `${key.substring(0, CONFIG.KEY_MASK_PREFIX_LENGTH)}...${key.substring(key.length - CONFIG.KEY_MASK_SUFFIX_LENGTH)}`;
}

function formatDate(timestamp: number | null | undefined): string {
  if (!timestamp && timestamp !== 0) return 'N/A';

  try {
    return new Date(timestamp).toISOString().split('T')[0];
  } catch {
    return 'Invalid Date';
  }
}

function getBeijingTime(): Date {
  return new Date(Date.now() + CONFIG.TIMEZONE_OFFSET_HOURS * 60 * 60 * 1000);
}

function createJsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function createErrorResponse(message: string, status = 500): Response {
  return createJsonResponse({ error: message }, status);
}

// HTML content is embedded as a template string
const HTML_CONTENT = `  
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta http-equiv="Content-Type" content="text/html; charset=UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>API 余额监控看板</title>  
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Microsoft YaHei', sans-serif; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); min-height: 100vh; padding: 20px; }
        .container { max-width: 1400px; margin: 0 auto; background: white; border-radius: 16px; box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3); overflow: hidden; }
        .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; text-align: center; position: relative; }
        .header h1 { font-size: 32px; margin-bottom: 10px; }
        .header .update-time { font-size: 14px; opacity: 0.9; }
        .manage-btn { position: absolute; top: 30px; right: 30px; background: rgba(255, 255, 255, 0.2); color: white; border: 2px solid white; border-radius: 8px; padding: 10px 20px; font-size: 14px; cursor: pointer; transition: all 0.3s ease; }
        .manage-btn:hover { background: rgba(255, 255, 255, 0.3); transform: scale(1.05); }
        .stats-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 20px; padding: 30px; background: #f8f9fa; }
        .stat-card { background: white; border-radius: 12px; padding: 20px; text-align: center; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1); transition: transform 0.3s ease, box-shadow 0.3s ease; }
        .stat-card:hover { transform: translateY(-5px); box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15); }
        .stat-card .label { font-size: 13px; color: #6c757d; margin-bottom: 8px; font-weight: 500; }
        .stat-card .value { font-size: 24px; font-weight: bold; color: #667eea; }
        .table-container { padding: 0 30px 30px 30px; overflow-x: auto; }
        table { width: 100%; border-collapse: collapse; background: white; border-radius: 8px; overflow: hidden; }
        thead { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; }
        th { padding: 15px; text-align: left; font-weight: 600; font-size: 14px; white-space: nowrap; }
        th.number { text-align: right; }
        td { padding: 12px 15px; border-bottom: 1px solid #e9ecef; font-size: 14px; }
        td.number { text-align: right; font-weight: 500; }
        td.error-row { color: #dc3545; }
        tbody tr:hover { background-color: #f8f9fa; }
        tbody tr:last-child td { border-bottom: none; }
        tfoot { background: #f8f9fa; font-weight: bold; }
        tfoot td { padding: 15px; border-top: 2px solid #667eea; border-bottom: none; }
        .key-cell { color: #495057; max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .refresh-btn { position: fixed; bottom: 30px; right: 30px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; border: none; border-radius: 50px; padding: 15px 30px; font-size: 16px; cursor: pointer; box-shadow: 0 4px 15px rgba(102, 126, 234, 0.4); transition: all 0.3s ease; display: flex; align-items: center; gap: 8px; }
        .refresh-btn:hover { transform: translateY(-2px); box-shadow: 0 6px 20px rgba(102, 126, 234, 0.6); }
        .refresh-btn:active { transform: translateY(0); }
        .delete-zero-btn { position: fixed; bottom: 95px; right: 30px; background: linear-gradient(135deg, #dc3545 0%, #c82333 100%); color: white; border: none; border-radius: 50px; padding: 15px 30px; font-size: 16px; cursor: pointer; box-shadow: 0 4px 15px rgba(220, 53, 69, 0.4); transition: all 0.3s ease; display: flex; align-items: center; gap: 8px; }
        .delete-zero-btn:hover { transform: translateY(-2px); box-shadow: 0 6px 20px rgba(220, 53, 69, 0.6); }
        .delete-zero-btn:active { transform: translateY(0); }
        .delete-zero-btn:disabled { opacity: 0.6; cursor: not-allowed; }
        .loading { text-align: center; padding: 40px; color: #6c757d; }
        .error { text-align: center; padding: 40px; color: #dc3545; }
        @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
        .spinner { display: inline-block; width: 20px; height: 20px; border: 3px solid rgba(255, 255, 255, 0.3); border-radius: 50%; border-top-color: white; animation: spin 1s linear infinite; }

        /* Modal styles */
        .modal { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0, 0, 0, 0.5); z-index: 1000; align-items: center; justify-content: center; }
        .modal.show { display: flex; }
        .modal-content { background: white; border-radius: 16px; width: 90%; max-width: 800px; max-height: 90vh; overflow: auto; box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3); }
        .modal-header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 20px 30px; display: flex; justify-content: space-between; align-items: center; }
        .modal-header h2 { font-size: 24px; }
        .close-btn { background: none; border: none; color: white; font-size: 28px; cursor: pointer; line-height: 1; }
        .modal-body { padding: 30px; }
        .form-group { margin-bottom: 20px; }
        .form-group label { display: block; margin-bottom: 8px; font-weight: 600; color: #333; }
        .form-group input, .form-group textarea { width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 8px; font-size: 14px; font-family: inherit; }
        .form-group textarea { min-height: 150px; font-family: 'Courier New', monospace; }
        .btn { padding: 12px 24px; border: none; border-radius: 8px; font-size: 14px; cursor: pointer; transition: all 0.3s ease; font-weight: 600; }
        .btn-primary { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; }
        .btn-primary:hover { transform: translateY(-2px); box-shadow: 0 4px 12px rgba(102, 126, 234, 0.4); }
        .btn-secondary { background: #6c757d; color: white; }
        .btn-secondary:hover { background: #5a6268; }
        .btn-danger { background: #dc3545; color: white; }
        .btn-danger:hover { background: #c82333; }
        .btn-group { display: flex; gap: 10px; margin-top: 20px; }
        .keys-list { margin-top: 30px; }
        .keys-list h3 { margin-bottom: 15px; color: #333; }
        .key-item { display: flex; justify-content: space-between; align-items: center; padding: 12px 15px; border: 1px solid #e9ecef; border-radius: 8px; margin-bottom: 10px; background: #f8f9fa; }
        .key-item-info { flex: 1; overflow: hidden; }
        .key-item-id { font-weight: 600; color: #667eea; margin-bottom: 4px; }
        .key-item-key { font-family: 'Courier New', monospace; font-size: 12px; color: #6c757d; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .tabs { display: flex; border-bottom: 2px solid #e9ecef; margin-bottom: 20px; }
        .tab { padding: 12px 24px; background: none; border: none; font-size: 16px; font-weight: 600; color: #6c757d; cursor: pointer; border-bottom: 3px solid transparent; transition: all 0.3s ease; }
        .tab.active { color: #667eea; border-bottom-color: #667eea; }
        .tab-content { display: none; }
        .tab-content.active { display: block; }
        .success-msg { background: #d4edda; color: #155724; padding: 12px; border-radius: 8px; margin-bottom: 15px; border: 1px solid #c3e6cb; }
        .error-msg { background: #f8d7da; color: #721c24; padding: 12px; border-radius: 8px; margin-bottom: 15px; border: 1px solid #f5c6cb; }
    </style>  
</head>  
<body>
    <div class="container">
        <div class="header">
            <button class="manage-btn" onclick="openManageModal()">Key 管理</button>
            <h1>API 余额监控看板</h1>
            <div class="update-time" id="updateTime">正在加载...</div>
        </div>


        <div class="stats-cards" id="statsCards"></div>


        <div class="table-container">
            <div id="tableContent">
                <div class="loading">正在加载数据...</div>
            </div>
        </div>
    </div>

    <button class="delete-zero-btn" onclick="deleteZeroBalanceKeys()" id="deleteZeroBtn">
        <span>🗑️ 删除0额度Key</span>
    </button>

    <button class="refresh-btn" onclick="loadData()">
        <span class="spinner" style="display: none;" id="spinner"></span>
        <span id="btnText">刷新数据</span>
    </button>

    <!-- Key Management Modal -->
    <div id="manageModal" class="modal">
        <div class="modal-content">
            <div class="modal-header">
                <h2>API Key 管理</h2>
                <button class="close-btn" onclick="closeManageModal()">&times;</button>
            </div>
            <div class="modal-body">
                <div id="modalMessage"></div>

                <!-- Batch Import -->
                <form onsubmit="batchImportKeys(event)">
                    <div class="form-group">
                        <label>批量导入 Keys（每行一个 Key）</label>
                        <textarea id="batchKeysInput" placeholder="例如:&#10;fk-xxxxx&#10;fk-yyyyy&#10;fk-zzzzz"></textarea>
                    </div>
                    <div class="btn-group">
                        <button type="submit" class="btn btn-primary">批量导入</button>
                        <button type="button" class="btn btn-secondary" onclick="document.getElementById('batchKeysInput').value='';">清空</button>
                    </div>
                </form>
            </div>
        </div>
    </div>  
  
  
    <script>
        // Global variable to store current API data
        let currentApiData = null;

        function formatNumber(num) {
            if (num === undefined || num === null) {
                return '0';
            }
            return new Intl.NumberFormat('en-US').format(num);
        }


        function formatPercentage(ratio) {
            if (ratio === undefined || ratio === null) {
                return '0.00%';
            }
            return (ratio * 100).toFixed(2) + '%';
        }  
  
  
        function loadData() {  
            const spinner = document.getElementById('spinner');  
            const btnText = document.getElementById('btnText');  
                
            spinner.style.display = 'inline-block';  
            btnText.textContent = '加载中...';  
  
  
            fetch('/api/data?t=' + new Date().getTime())  
                .then(response => {  
                    if (!response.ok) {  
                        throw new Error('无法加载数据: ' + response.statusText);  
                    }  
                    return response.json();  
                })  
                .then(data => {  
                    if (data.error) {  
                        throw new Error(data.error);  
                    }  
                    displayData(data);  
                })  
                .catch(error => {  
                    document.getElementById('tableContent').innerHTML = \`<div class="error">❌ 加载失败: \${error.message}</div>\`;  
                    document.getElementById('updateTime').textContent = "加载失败";  
                })  
                .finally(() => {  
                    spinner.style.display = 'none';  
                    btnText.textContent = '🔄 刷新数据';  
                });  
        }  
  
  
        function displayData(data) {
            // Store data globally for other functions to use
            currentApiData = data;

            document.getElementById('updateTime').textContent = \`最后更新: \${data.update_time} | 共 \${data.total_count} 个API Key\`;

            const totalAllowance = data.totals.total_totalAllowance;
            const totalUsed = data.totals.total_orgTotalTokensUsed;
            // MODIFICATION: Use the totalRemaining value calculated on the backend.
            const totalRemaining = data.totals.totalRemaining;
            const overallRatio = totalAllowance > 0 ? totalUsed / totalAllowance : 0;  
  
  
            const statsCards = document.getElementById('statsCards');  
            statsCards.innerHTML = \`  
                <div class="stat-card"><div class="label">总计额度 (Total Allowance)</div><div class="value">\${formatNumber(totalAllowance)}</div></div>  
                <div class="stat-card"><div class="label">已使用 (Total Used)</div><div class="value">\${formatNumber(totalUsed)}</div></div>  
                <div class="stat-card"><div class="label">剩余额度 (Remaining)</div><div class="value">\${formatNumber(totalRemaining)}</div></div>  
                <div class="stat-card"><div class="label">使用百分比 (Usage %)</div><div class="value">\${formatPercentage(overallRatio)}</div></div>  
            \`;  
  
  
            let tableHTML = \`
                <table>
                    <thead>
                        <tr>
                            <th>API Key</th>
                            <th>开始时间</th>
                            <th>结束时间</th>
                            <th class="number">总计额度</th>
                            <th class="number">已使用</th>
                            <th class="number">剩余额度</th>
                            <th class="number">使用百分比</th>
                            <th style="text-align: center;">操作</th>
                        </tr>
                    </thead>
                    <tbody>\`;


            data.data.forEach(item => {
                if (item.error) {
                    tableHTML += \`
                        <tr>
                            <td class="key-cell" title="\${item.key}">\${item.key}</td>
                            <td colspan="5" class="error-row">加载失败: \${item.error}</td>
                            <td style="text-align: center;">
                                <button class="btn btn-danger" onclick="deleteKeyFromTable('\${item.id}')" style="padding: 6px 12px; font-size: 12px;">删除</button>
                            </td>
                        </tr>\`;
                } else {
                    // MODIFICATION: Calculate remaining here, ensuring it's not negative.
                    const remaining = Math.max(0, item.totalAllowance - item.orgTotalTokensUsed);
                    tableHTML += \`
                        <tr>
                            <td class="key-cell" title="\${item.key}">\${item.key}</td>
                            <td>\${item.startDate}</td>
                            <td>\${item.endDate}</td>
                            <td class="number">\${formatNumber(item.totalAllowance)}</td>
                            <td class="number">\${formatNumber(item.orgTotalTokensUsed)}</td>
                            <td class="number">\${formatNumber(remaining)}</td>
                            <td class="number">\${formatPercentage(item.usedRatio)}</td>
                            <td style="text-align: center;">
                                <button class="btn btn-danger" onclick="deleteKeyFromTable('\${item.id}')" style="padding: 6px 12px; font-size: 12px;">删除</button>
                            </td>
                        </tr>\`;
                }
            });


            tableHTML += \`
                    </tbody>
                    <tfoot>
                        <tr>
                            <td colspan="3">总计 (SUM)</td>
                            <td class="number">\${formatNumber(totalAllowance)}</td>
                            <td class="number">\${formatNumber(totalUsed)}</td>
                            <td class="number">\${formatNumber(totalRemaining)}</td>
                            <td class="number">\${formatPercentage(overallRatio)}</td>
                            <td></td>
                        </tr>
                    </tfoot>
                </table>\`;  
  
  
            document.getElementById('tableContent').innerHTML = tableHTML;  
        }  
  
  
        document.addEventListener('DOMContentLoaded', loadData);

        // Modal and Key Management Functions
        function openManageModal() {
            document.getElementById('manageModal').classList.add('show');
            clearMessage();
        }

        function closeManageModal() {
            document.getElementById('manageModal').classList.remove('show');
            clearMessage();
        }

        function showMessage(message, isError = false) {
            const msgDiv = document.getElementById('modalMessage');
            msgDiv.innerHTML = \`<div class="\${isError ? 'error-msg' : 'success-msg'}">\${message}</div>\`;
            setTimeout(() => clearMessage(), 5000);
        }

        function clearMessage() {
            document.getElementById('modalMessage').innerHTML = '';
        }

        async function deleteZeroBalanceKeys() {
            if (!currentApiData) {
                alert('请先加载数据');
                return;
            }

            // Find all keys with zero remaining balance
            const zeroBalanceKeys = currentApiData.data.filter(item => {
                if (item.error) return false; // Skip error items
                const remaining = Math.max(0, (item.totalAllowance || 0) - (item.orgTotalTokensUsed || 0));
                return remaining === 0;
            });

            if (zeroBalanceKeys.length === 0) {
                alert('没有找到余额为0的Key');
                return;
            }

            const confirmMsg = \`确定要删除 \${zeroBalanceKeys.length} 个余额为0的Key吗？\\n\\n将删除以下Key ID:\\n\${zeroBalanceKeys.map(k => k.id).join('\\n')}\`;

            if (!confirm(confirmMsg)) {
                return;
            }

            const deleteBtn = document.getElementById('deleteZeroBtn');
            deleteBtn.disabled = true;
            deleteBtn.innerHTML = '<span>⏳ 删除中...</span>';

            try {
                const response = await fetch('/api/keys/batch-delete', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ ids: zeroBalanceKeys.map(k => k.id) })
                });

                const result = await response.json();

                if (response.ok) {
                    alert(\`成功删除 \${result.deleted || zeroBalanceKeys.length} 个Key\`);
                    loadData(); // Refresh data
                } else {
                    alert('删除失败: ' + (result.error || '未知错误'));
                }
            } catch (error) {
                alert('网络错误: ' + error.message);
            } finally {
                deleteBtn.disabled = false;
                deleteBtn.innerHTML = '<span>🗑️ 删除0额度Key</span>';
            }
        }

        async function batchImportKeys(event) {
            event.preventDefault();
            const input = document.getElementById('batchKeysInput').value.trim();

            if (!input) {
                showMessage('请输入要导入的 Keys', true);
                return;
            }

            const lines = input.split('\\n').map(line => line.trim()).filter(line => line.length > 0);
            const keysToImport = [];
            // Use timestamp + random to generate unique IDs
            const timestamp = Date.now();
            let autoIdCounter = 1;

            for (const line of lines) {
                if (line.includes(':')) {
                    // Format: ID:KEY
                    const [id, key] = line.split(':').map(s => s.trim());
                    if (id && key) {
                        keysToImport.push({ id, key });
                    }
                } else {
                    // Pure key, auto-generate unique ID using timestamp
                    const randomSuffix = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
                    keysToImport.push({
                        id: \`key-\${timestamp}-\${autoIdCounter++}-\${randomSuffix}\`,
                        key: line
                    });
                }
            }

            if (keysToImport.length === 0) {
                showMessage('没有有效的 Key 可以导入', true);
                return;
            }

            try {
                const response = await fetch('/api/keys', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(keysToImport)
                });

                const result = await response.json();

                if (response.ok) {
                    const msg = \`成功导入 \${result.added} 个 Key\${result.skipped > 0 ? \`, 跳过 \${result.skipped} 个重复的 Key\` : ''}\`;
                    showMessage(msg);
                    document.getElementById('batchKeysInput').value = '';
                    loadData(); // Refresh main data
                } else {
                    showMessage(result.error || '批量导入失败', true);
                }
            } catch (error) {
                showMessage('网络错误: ' + error.message, true);
            }
        }

        async function deleteKeyFromTable(id) {
            if (!confirm(\`确定要删除 Key "\${id}" 吗？\`)) {
                return;
            }

            try {
                const response = await fetch(\`/api/keys/\${id}\`, {
                    method: 'DELETE'
                });

                const result = await response.json();

                if (response.ok) {
                    alert(\`Key "\${id}" 已删除成功\`);
                    loadData(); // Refresh main data
                } else {
                    alert('删除失败: ' + (result.error || '未知错误'));
                }
            } catch (error) {
                alert('网络错误: ' + error.message);
            }
        }

        // Close modal when clicking outside
        document.addEventListener('click', function(event) {
            const modal = document.getElementById('manageModal');
            if (event.target === modal) {
                closeManageModal();
            }
        });
    </script>
</body>
</html>
`;  
  
  
// ==================== API Data Fetching ====================

/**
 * Fetches usage data for a single API key.
 */
async function fetchApiKeyData(id: string, key: string): Promise<ApiKeyResult> {
  const maskedKey = maskApiKey(key);

  try {
    const response = await fetch(CONFIG.API_ENDPOINT, {
      headers: {
        'Authorization': `Bearer ${key}`,
        'User-Agent': CONFIG.USER_AGENT,
      }
    });

    if (!response.ok) {
      const errorBody = await response.text();
      console.error(`Error fetching data for key ID ${id}: ${response.status} ${errorBody}`);
      return { id, key: maskedKey, error: `HTTP ${response.status}` };
    }

    const apiData: ApiResponse = await response.json();

    // Validate response structure
    if (!apiData.usage || !apiData.usage.standard) {
      return { id, key: maskedKey, error: 'Invalid API response structure' };
    }

    const { usage } = apiData;
    const { standard } = usage;

    return {
      id,
      key: maskedKey,
      startDate: formatDate(usage.startDate),
      endDate: formatDate(usage.endDate),
      orgTotalTokensUsed: standard.orgTotalTokensUsed || 0,
      totalAllowance: standard.totalAllowance || 0,
      usedRatio: standard.usedRatio || 0,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`Failed to process key ID ${id}:`, errorMessage);
    return { id, key: maskedKey, error: 'Failed to fetch' };
  }
}  
  
  
// ==================== Type Guards ====================

function isApiUsageData(result: ApiKeyResult): result is ApiUsageData {
  return !('error' in result);
}

function isApiErrorData(result: ApiKeyResult): result is ApiErrorData {
  return 'error' in result;
}

// ==================== Data Aggregation ====================

/**
 * Aggregates data from all configured API keys.
 */
async function getAggregatedData(): Promise<AggregatedResponse> {
  // Get keys from KV database
  const keyPairs = await getAllKeys();

  if (keyPairs.length === 0) {
    throw new Error("No API keys found in database. Please add keys via the management interface.");
  }

  // Fetch all API key data in parallel
  const results = await Promise.all(
    keyPairs.map(({ id, key }) => fetchApiKeyData(id, key))
  );

  // Filter valid results (non-error)
  const validResults = results.filter(isApiUsageData);

  // Calculate totals, ensuring totalRemaining is not negative
  const totals = validResults.reduce((acc, res) => {
    acc.total_orgTotalTokensUsed += res.orgTotalTokensUsed;
    acc.total_totalAllowance += res.totalAllowance;

    // Calculate remaining for each key and add it to the total
    const remaining = res.totalAllowance - res.orgTotalTokensUsed;
    acc.totalRemaining += Math.max(0, remaining);

    return acc;
  }, {
    total_orgTotalTokensUsed: 0,
    total_totalAllowance: 0,
    totalRemaining: 0,
  });

  // Log keys with remaining balance
  logKeysWithBalance(validResults, keyPairs);

  const beijingTime = getBeijingTime();

  return {
    update_time: format(beijingTime, "yyyy-MM-dd HH:mm:ss"),
    total_count: keyPairs.length,
    totals,
    data: results,
  };
}

/**
 * Logs API keys that still have remaining balance.
 */
function logKeysWithBalance(validResults: ApiUsageData[], keyPairs: ApiKey[]): void {
  const keysWithBalance = validResults.filter(r => {
    const remaining = r.totalAllowance - r.orgTotalTokensUsed;
    return remaining > 0;
  });

  if (keysWithBalance.length > 0) {
    console.log("=".repeat(80));
    console.log("📋 剩余额度大于0的API Keys:");
    console.log("-".repeat(80));

    keysWithBalance.forEach(item => {
      const originalKeyPair = keyPairs.find(kp => kp.id === item.id);
      if (originalKeyPair) {
        console.log(originalKeyPair.key);
      }
    });

    console.log("=".repeat(80) + "\n");
  } else {
    console.log("\n⚠️  没有剩余额度大于0的API Keys\n");
  }
}  
  
  
// ==================== Route Handlers ====================

/**
 * Handles the root path - serves the HTML dashboard.
 */
function handleRoot(): Response {
  return new Response(HTML_CONTENT, {
    headers: { "Content-Type": "text/html; charset=utf-8" }
  });
}

/**
 * Handles the /api/data endpoint - returns aggregated usage data.
 */
async function handleGetData(): Promise<Response> {
  try {
    const data = await getAggregatedData();
    return createJsonResponse(data);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('Error fetching aggregated data:', errorMessage);
    return createErrorResponse(errorMessage, 500);
  }
}

/**
 * Handles GET /api/keys - returns all stored API keys.
 */
async function handleGetKeys(): Promise<Response> {
  try {
    const keys = await getAllKeys();
    return createJsonResponse(keys);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('Error getting keys:', errorMessage);
    return createErrorResponse(errorMessage, 500);
  }
}

/**
 * Handles POST /api/keys - adds single or multiple API keys.
 */
async function handleAddKeys(req: Request): Promise<Response> {
  try {
    const body = await req.json();

    // Support batch import
    if (Array.isArray(body)) {
      return await handleBatchImport(body);
    } else {
      return await handleSingleKeyAdd(body);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Invalid JSON';
    console.error('Error adding keys:', errorMessage);
    return createErrorResponse(errorMessage, 400);
  }
}

/**
 * Handles batch import of multiple API keys.
 */
async function handleBatchImport(items: unknown[]): Promise<Response> {
  let added = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const item of items) {
    // Validate item structure
    if (!item || typeof item !== 'object' || !('id' in item) || !('key' in item)) {
      errors.push(`Invalid entry: missing id or key`);
      continue;
    }

    const { id, key } = item as { id: string; key: string };

    if (!id || !key) {
      errors.push(`Invalid entry: empty id or key`);
      continue;
    }

    if (await keyExists(id)) {
      skipped++;
      continue;
    }

    await addKey(id, key);
    added++;
  }

  const result: BatchImportResult = {
    success: true,
    added,
    skipped,
    errors: errors.length > 0 ? errors : undefined
  };

  return createJsonResponse(result);
}

/**
 * Handles adding a single API key.
 */
async function handleSingleKeyAdd(body: unknown): Promise<Response> {
  // Validate body structure
  if (!body || typeof body !== 'object' || !('id' in body) || !('key' in body)) {
    return createErrorResponse("id and key are required", 400);
  }

  const { id, key } = body as { id: string; key: string };

  if (!id || !key) {
    return createErrorResponse("id and key cannot be empty", 400);
  }

  if (await keyExists(id)) {
    return createErrorResponse("Key ID already exists", 409);
  }

  await addKey(id, key);
  return createJsonResponse({ success: true });
}

/**
 * Handles DELETE /api/keys/:id - deletes a specific API key.
 */
async function handleDeleteKey(pathname: string): Promise<Response> {
  try {
    const id = pathname.split("/api/keys/")[1];

    if (!id) {
      return createErrorResponse("Key ID is required", 400);
    }

    if (!await keyExists(id)) {
      return createErrorResponse("Key not found", 404);
    }

    await deleteKey(id);
    return createJsonResponse({ success: true });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('Error deleting key:', errorMessage);
    return createErrorResponse(errorMessage, 500);
  }
}

/**
 * Handles POST /api/keys/batch-delete - deletes multiple API keys at once.
 */
async function handleBatchDeleteKeys(req: Request): Promise<Response> {
  try {
    const body = await req.json();

    // Validate body structure
    if (!body || typeof body !== 'object' || !('ids' in body)) {
      return createErrorResponse("ids array is required", 400);
    }

    const { ids } = body as { ids: unknown };

    if (!Array.isArray(ids)) {
      return createErrorResponse("ids must be an array", 400);
    }

    if (ids.length === 0) {
      return createErrorResponse("ids array cannot be empty", 400);
    }

    let deleted = 0;
    let notFound = 0;
    const errors: string[] = [];

    for (const id of ids) {
      if (typeof id !== 'string' || !id) {
        errors.push(`Invalid ID: ${id}`);
        continue;
      }

      if (!await keyExists(id)) {
        notFound++;
        continue;
      }

      try {
        await deleteKey(id);
        deleted++;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        errors.push(`Failed to delete ${id}: ${errorMessage}`);
      }
    }

    return createJsonResponse({
      success: true,
      deleted,
      notFound,
      errors: errors.length > 0 ? errors : undefined
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Invalid JSON';
    console.error('Error batch deleting keys:', errorMessage);
    return createErrorResponse(errorMessage, 400);
  }
}

// ==================== Main Request Handler ====================

/**
 * Main HTTP request handler that routes requests to appropriate handlers.
 */
async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);

  // Route: Root path - Dashboard
  if (url.pathname === "/") {
    return handleRoot();
  }

  // Route: GET /api/data - Get aggregated usage data
  if (url.pathname === "/api/data" && req.method === "GET") {
    return await handleGetData();
  }

  // Route: GET /api/keys - Get all keys
  if (url.pathname === "/api/keys" && req.method === "GET") {
    return await handleGetKeys();
  }

  // Route: POST /api/keys - Add key(s)
  if (url.pathname === "/api/keys" && req.method === "POST") {
    return await handleAddKeys(req);
  }

  // Route: POST /api/keys/batch-delete - Batch delete keys
  if (url.pathname === "/api/keys/batch-delete" && req.method === "POST") {
    return await handleBatchDeleteKeys(req);
  }

  // Route: DELETE /api/keys/:id - Delete a key
  if (url.pathname.startsWith("/api/keys/") && req.method === "DELETE") {
    return await handleDeleteKey(url.pathname);
  }

  // 404 for all other routes
  return new Response("Not Found", { status: 404 });
}

// ==================== Server Initialization ====================

console.log(`Server running on http://localhost:${CONFIG.PORT}`);
serve(handler);
