// utils/fileApi.ts
// 嘉禾志愿 2.0 文件上传最小客户端（P33-P3A-2）。
// 仅对接 /api/v2/files；绝不调用 legacy PHP 上传端点（upload_avatar.php / upload_quick_action.php 等）。
//
// 职责边界（严格）：
// - 本文件【只负责上传】，不负责选图。chooseMedia / chooseImage 及 sizeType:['compressed']
//   由 P33-P4 页面层负责（压缩图可避免 HEIC/HEIF 与超大原图）。
// - 不创建 Community 页面、不改 app.json、不改 tabBar、不动 quick-action。

const V2_BASE = 'https://api.jhzyfw.com/api/v2';

export interface FileSafeView {
  file_public_id: string;
  original_name: string;
  mime_type: string;
  size_bytes: number;
  visibility: string;
  scan_status: number;
}

export interface ApiError {
  status: number;
  code: string;
  message: string;
  details?: Record<string, string>;
  isNetwork: boolean;
}

function getToken(): string {
  return wx.getStorageSync('access_token') || wx.getStorageSync('token') || '';
}

function getActiveTeamId(): string {
  return wx.getStorageSync('activeTeamPublicId') || '';
}

function buildError(status: number, raw: any, isNetwork: boolean): ApiError {
  let body: any = null;
  if (typeof raw === 'string') {
    try {
      body = JSON.parse(raw);
    } catch (e) {
      body = null;
    }
  } else {
    body = raw;
  }
  const errBody = body && body.error ? body.error : null;
  return {
    status,
    code: errBody ? errBody.code : '',
    message: errBody ? errBody.message : isNetwork ? '网络异常，请重试' : '上传失败',
    details: errBody && errBody.details ? errBody.details : undefined,
    isNetwork,
  };
}

/**
 * 上传 Community 图片（单文件）。
 * @param tempFilePath wx.chooseMedia / wx.chooseImage 返回的本地临时路径
 * @param base 可选：覆盖 API base（本地联调用；默认 https://api.jhzyfw.com/api/v2）
 */
export function uploadCommunityImage(tempFilePath: string, base?: string): Promise<FileSafeView> {
  const url = (base || V2_BASE) + '/files';
  const header: Record<string, string> = {};
  const token = getToken();
  if (token) header['Authorization'] = `Bearer ${token}`;
  const teamId = getActiveTeamId();
  if (teamId) header['X-Team-Id'] = teamId;

  return new Promise<FileSafeView>((resolve, reject) => {
    wx.uploadFile({
      url,
      filePath: tempFilePath,
      name: 'file',
      formData: { purpose: 'community_attachment' },
      header,
      success: (res: any) => {
        const statusCode: number = res.statusCode;
        let body: any = null;
        try {
          body = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
        } catch (e) {
          body = null;
        }
        if (statusCode === 201 && body && body.success === true) {
          resolve(body.data as FileSafeView);
        } else {
          reject(buildError(statusCode, body, false));
        }
      },
      fail: () => {
        reject(buildError(0, null, true));
      },
    });
  });
}

/**
 * 组装 Community 图片的可展示地址（经 Worker 代理下载，需携带会话）。
 * 注意：不是 R2 直链；小程序 image 组件若需鉴权头，请改用下载到本地临时文件后展示。
 */
export function fileUrl(filePublicId: string, base?: string): string {
  return (base || V2_BASE) + '/files/' + encodeURIComponent(filePublicId);
}

/**
 * 下载受保护 Community 图片到本地临时文件（需鉴权头）。
 * 与小程序前端 community 页面已验证模式一致：Bearer + X-Team-Id → wx.downloadFile → tempFilePath。
 * 不允许直接将受保护 URL 绑定到 <image src>。
 * @returns 成功返回 tempFilePath；失败/无权限返回 null。
 */
export function downloadAuthImage(filePublicId: string, base?: string): Promise<string | null> {
  const url = (base || V2_BASE) + '/files/' + encodeURIComponent(filePublicId);
  const header: Record<string, string> = {};
  const token = getToken();
  if (token) header['Authorization'] = `Bearer ${token}`;
  const teamId = getActiveTeamId();
  if (teamId) header['X-Team-Id'] = teamId;
  return new Promise<string | null>((resolve) => {
    wx.downloadFile({
      url,
      header,
      success: (res: any) => {
        if (res.statusCode === 200 && res.tempFilePath) resolve(res.tempFilePath);
        else resolve(null);
      },
      fail: () => resolve(null),
    });
  });
}
