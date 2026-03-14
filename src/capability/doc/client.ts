import type { ResolvedAgentAccount } from "../../types/index.js";
import { getAccessToken } from "../../transport/agent-api/core.js";
import { wecomFetch } from "../../http.js";
import { resolveWecomEgressProxyUrlFromNetwork } from "../../config/index.js";
import { LIMITS } from "../../types/constants.js";
import {
    BatchUpdateDocResponse,
    GetDocContentResponse,
    Node,
    UpdateRequest
} from "./types.js";

function readString(value: unknown): string {
    const trimmed = String(value ?? "").trim();
    return trimmed || "";
}

function normalizeDocType(docType: unknown): 3 | 4 | 10 {
    if (docType === 3 || docType === "3") return 3;
    if (docType === 4 || docType === "4") return 4;
    if (docType === 10 || docType === "10" || docType === 5 || docType === "5") return 10;
    const normalized = readString(docType).toLowerCase();
    if (!normalized || normalized === "doc") return 3;
    if (normalized === "spreadsheet" || normalized === "sheet" || normalized === "table") return 4;
    if (normalized === "smart_table" || normalized === "smarttable") return 10;
    throw new Error(`Unsupported WeCom docType: ${String(docType)}`);
}

function mapDocTypeLabel(docType: 3 | 4 | 10): string {
    if (docType === 10) return "smart_table";
    if (docType === 4) return "spreadsheet";
    return "doc";
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readObject(value: unknown): Record<string, unknown> {
    return isRecord(value) ? value : {};
}

function readArray(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
}

export interface DocMemberEntry {
    userid?: string;
    partyid?: string;
    tagid?: string;
    auth?: number;
}

function normalizeDocMemberEntry(value: unknown): DocMemberEntry | null {
    if (typeof value === "string" || typeof value === "number") {
        const userid = readString(value);
        return userid ? { userid } : null;
    }
    if (!isRecord(value)) return null;
    const entry: DocMemberEntry = { ...value } as DocMemberEntry;
    if (!readString(entry.userid) && readString(value.userId)) {
        entry.userid = readString(value.userId);
    }
    if (!readString(entry.userid) && !readString(entry.partyid) && !readString(entry.tagid)) {
        return null;
    }
    if (readString(entry.userid)) entry.userid = readString(entry.userid);
    if (readString(entry.partyid)) entry.partyid = readString(entry.partyid);
    if (readString(entry.tagid)) entry.tagid = readString(entry.tagid);
    if (entry.auth !== undefined) entry.auth = Number(entry.auth);
    return entry;
}

function normalizeDocMemberEntryList(values: unknown): DocMemberEntry[] {
    return readArray(values).map(normalizeDocMemberEntry).filter((v): v is DocMemberEntry => v !== null);
}

function buildDocMemberAuthRequest(params: {
    docId: string;
    viewers?: unknown;
    collaborators?: unknown;
    removeViewers?: unknown;
    removeCollaborators?: unknown;
    authLevel?: number;
}): Record<string, unknown> {
    const { docId, viewers, collaborators, removeViewers, removeCollaborators, authLevel } = params;
    const payload: Record<string, unknown> = {
        docid: readString(docId),
    };
    if (!payload.docid) throw new Error("docId required");

    const normalizedViewers = normalizeDocMemberEntryList(viewers).map(v => ({ ...v, auth: v.auth ?? authLevel ?? 1 }));
    const normalizedCollaborators = normalizeDocMemberEntryList(collaborators).map(v => ({ ...v, auth: v.auth ?? authLevel ?? 2 }));
    const normalizedRemovedViewers = normalizeDocMemberEntryList(removeViewers);
    const normalizedRemovedCollaborators = normalizeDocMemberEntryList(removeCollaborators);

    if (normalizedViewers.length > 0) payload.update_file_member_list = normalizedViewers;
    if (normalizedCollaborators.length > 0) payload.update_co_auth_list = normalizedCollaborators;
    if (normalizedRemovedViewers.length > 0) payload.del_file_member_list = normalizedRemovedViewers;
    if (normalizedRemovedCollaborators.length > 0) payload.del_co_auth_list = normalizedRemovedCollaborators;

    if (
        !payload.update_doc_member_list &&
        !payload.update_co_auth_list &&
        !payload.del_doc_member_list &&
        !payload.del_co_auth_list
    ) {
        throw new Error("at least one viewer/collaborator change is required");
    }

    return payload;
}

async function parseJsonResponse(res: Response, actionLabel: string): Promise<any> {
    let payload: any = null;
    try {
        payload = await res.json();
    } catch {
        if (!res.ok) {
            throw new Error(`WeCom ${actionLabel} failed: HTTP ${res.status}`);
        }
        throw new Error(`WeCom ${actionLabel} failed: invalid JSON response`);
    }
    if (!payload || typeof payload !== "object") {
        throw new Error(`WeCom ${actionLabel} failed: empty response`);
    }
    if (!res.ok) {
        throw new Error(`WeCom ${actionLabel} failed: HTTP ${res.status} ${JSON.stringify(payload)}`);
    }
    if (Array.isArray(payload)) {
        const failedItem = payload.find((item) => Number(item?.errcode ?? 0) !== 0);
        if (failedItem) {
            throw new Error(
                `WeCom ${actionLabel} failed: ${String(failedItem?.errmsg || "unknown error")} (errcode ${String(failedItem?.errcode)})`,
            );
        }
        return payload;
    }
    if (Number(payload.errcode ?? 0) !== 0) {
        throw new Error(
            `WeCom ${actionLabel} failed: ${String(payload.errmsg || "unknown error")} (errcode ${String(payload.errcode)})`,
        );
    }
    return payload;
}

export class WecomDocClient {
    private async postWecomDocApi(params: {
        path: string;
        actionLabel: string;
        agent: ResolvedAgentAccount;
        body: Record<string, unknown> | unknown[];
    }): Promise<any> {
        const { path, actionLabel, agent, body } = params;

        const token = await getAccessToken(agent);
        const url = `https://qyapi.weixin.qq.com${path}?access_token=${encodeURIComponent(token)}`;
        const proxyUrl = resolveWecomEgressProxyUrlFromNetwork(agent.network);

        let lastErr: any;
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                const res = await wecomFetch(url, {
                    method: "POST",
                    headers: {
                        "content-type": "application/json",
                    },
                    body: JSON.stringify(body ?? {}),
                }, { proxyUrl, timeoutMs: LIMITS.REQUEST_TIMEOUT_MS });

                return await parseJsonResponse(res, actionLabel);
            } catch (err) {
                lastErr = err;
                if (attempt < 3) {
                    await new Promise(r => setTimeout(r, 1000));
                }
            }
        }
        throw lastErr;
    }

    async createDoc(params: { agent: ResolvedAgentAccount; docName: string; docType?: unknown; spaceId?: string; fatherId?: string; adminUsers?: string[] }) {
        const { agent, docName, docType, spaceId, fatherId, adminUsers } = params;
        const normalizedDocType = normalizeDocType(docType);
        const payload: Record<string, unknown> = {
            doc_type: normalizedDocType,
            doc_name: readString(docName),
        };
        if (!payload.doc_name) throw new Error("docName required");
        const normalizedSpaceId = readString(spaceId);
        const normalizedFatherId = readString(fatherId);
        if (normalizedSpaceId) payload.spaceid = normalizedSpaceId;
        if (normalizedFatherId) payload.fatherid = normalizedFatherId;
        const normalizedAdminUsers = Array.isArray(adminUsers)
            ? adminUsers.map((item) => readString(item)).filter(Boolean)
            : [];
        if (normalizedAdminUsers.length > 0) {
            payload.admin_users = normalizedAdminUsers;
        }
        const json = await this.postWecomDocApi({
            path: "/cgi-bin/wedoc/create_doc",
            actionLabel: "create_doc",
            agent,
            body: payload,
        });
        return {
            raw: json,
            docId: readString(json.docid),
            url: readString(json.url),
            docType: normalizedDocType,
            docTypeLabel: mapDocTypeLabel(normalizedDocType),
        };
    }

    async renameDoc(params: { agent: ResolvedAgentAccount; docId: string; newName: string }) {
        const { agent, docId, newName } = params;
        const payload = {
            docid: readString(docId),
            new_name: readString(newName),
        };
        if (!payload.docid) throw new Error("docId required");
        if (!payload.new_name) throw new Error("newName required");
        const json = await this.postWecomDocApi({
            path: "/cgi-bin/wedoc/rename_doc",
            actionLabel: "rename_doc",
            agent,
            body: payload,
        });
        return {
            raw: json,
            docId: payload.docid,
            newName: payload.new_name,
        };
    }

    async copyDoc(params: { agent: ResolvedAgentAccount; docId: string; newName?: string; spaceId?: string; fatherId?: string }) {
        const { agent, docId, newName, spaceId, fatherId } = params;
        const payload: Record<string, unknown> = {
            docid: readString(docId),
        };
        if (!payload.docid) throw new Error("docId required");
        if (newName) payload.new_name = readString(newName);
        if (spaceId) payload.spaceid = readString(spaceId);
        if (fatherId) payload.fatherid = readString(fatherId);

        const json = await this.postWecomDocApi({
            path: "/cgi-bin/wedoc/smartsheet/copy",
            actionLabel: "copy_smartsheet",
            agent,
            body: payload,
        });
        return {
            raw: json,
            docId: readString(json.docid),
            url: readString(json.url),
        };
    }

    async getDocBaseInfo(params: { agent: ResolvedAgentAccount; docId: string }) {
        const { agent, docId } = params;
        const normalizedDocId = readString(docId);
        if (!normalizedDocId) throw new Error("docId required");
        const json = await this.postWecomDocApi({
            path: "/cgi-bin/wedoc/get_doc_base_info",
            actionLabel: "get_doc_base_info",
            agent,
            body: { docid: normalizedDocId },
        });
        return {
            raw: json,
            info: json.doc_base_info && typeof json.doc_base_info === "object" ? json.doc_base_info : {},
        };
    }

    async shareDoc(params: { agent: ResolvedAgentAccount; docId: string }) {
        const { agent, docId } = params;
        const normalizedDocId = readString(docId);
        if (!normalizedDocId) throw new Error("docId required");
        const json = await this.postWecomDocApi({
            path: "/cgi-bin/wedoc/doc_share",
            actionLabel: "doc_share",
            agent,
            body: { docid: normalizedDocId },
        });
        return {
            raw: json,
            shareUrl: readString(json.share_url),
        };
    }

    async getDocAuth(params: { agent: ResolvedAgentAccount; docId: string }) {
        const { agent, docId } = params;
        const normalizedDocId = readString(docId);
        if (!normalizedDocId) throw new Error("docId required");
        const json = await this.postWecomDocApi({
            path: "/cgi-bin/wedoc/doc_get_auth",
            actionLabel: "doc_get_auth",
            agent,
            body: { docid: normalizedDocId },
        });
        return {
            raw: json,
            accessRule: json.access_rule && typeof json.access_rule === "object" ? json.access_rule : {},
            secureSetting: json.secure_setting && typeof json.secure_setting === "object" ? json.secure_setting : {},
            docMembers: Array.isArray(json.doc_member_list) ? json.doc_member_list : [],
            coAuthList: Array.isArray(json.co_auth_list) ? json.co_auth_list : [],
        };
    }

    async deleteDoc(params: { agent: ResolvedAgentAccount; docId?: string; formId?: string }) {
        const { agent, docId, formId } = params;
        const payload: Record<string, string> = {};
        const normalizedDocId = readString(docId);
        const normalizedFormId = readString(formId);
        if (normalizedDocId) payload.docid = normalizedDocId;
        if (normalizedFormId) payload.formid = normalizedFormId;
        if (!payload.docid && !payload.formid) {
            throw new Error("docId or formId required");
        }
        const json = await this.postWecomDocApi({
            path: "/cgi-bin/wedoc/del_doc",
            actionLabel: "del_doc",
            agent,
            body: payload,
        });
        return {
            raw: json,
            docId: payload.docid || "",
            formId: payload.formid || "",
        };
    }

    async setDocJoinRule(params: { agent: ResolvedAgentAccount; docId: string; request: any }) {
        const { agent, docId, request } = params;
        const payload = {
            ...readObject(request),
        };
        payload.docid = readString(docId || payload.docid);
        if (!payload.docid) throw new Error("docId required");
        const json = await this.postWecomDocApi({
            path: "/cgi-bin/wedoc/mod_doc_join_rule",
            actionLabel: "mod_doc_join_rule",
            agent,
            body: payload,
        });
        return {
            raw: json,
            docId: payload.docid as string,
        };
    }

    async setDocMemberAuth(params: { agent: ResolvedAgentAccount; docId: string; request: any }) {
        const { agent, docId, request } = params;
        const payload = {
            ...readObject(request),
        };
        payload.docid = readString(docId || payload.docid);
        if (!payload.docid) throw new Error("docId required");
        const json = await this.postWecomDocApi({
            path: "/cgi-bin/wedoc/mod_doc_member",
            actionLabel: "mod_doc_member",
            agent,
            body: payload,
        });
        return {
            raw: json,
            docId: payload.docid as string,
        };
    }

    async grantDocAccess(params: {
        agent: ResolvedAgentAccount;
        docId: string;
        viewers?: unknown;
        collaborators?: unknown;
        removeViewers?: unknown;
        removeCollaborators?: unknown;
        authLevel?: number;
    }) {
        const { agent, docId, viewers, collaborators, removeViewers, removeCollaborators, authLevel } = params;
        
        let finalRemoveViewers = removeViewers;
        if (collaborators && !removeViewers) {
            try {
                const currentAuth = await this.getDocAuth({ agent, docId });
                const viewerUserIds = new Set(
                    (currentAuth.docMembers || [])
                        .filter((m: any) => m.type === 1 && m.userid)
                        .map((m: any) => m.userid)
                );
                const newCollaboratorUserIds = normalizeDocMemberEntryList(collaborators)
                    .map(e => e.userid)
                    .filter(Boolean) as string[];
                
                const needRemove = newCollaboratorUserIds.filter(uid => viewerUserIds.has(uid));
                if (needRemove.length > 0) {
                    const existingRemove = normalizeDocMemberEntryList(removeViewers);
                    finalRemoveViewers = [
                        ...existingRemove,
                        ...needRemove.map(uid => ({ userid: uid }))
                    ];
                }
            } catch {
                // Ignore auth check errors, proceed with original request
            }
        }

        const payload = buildDocMemberAuthRequest({
            docId,
            viewers,
            collaborators,
            removeViewers: finalRemoveViewers,
            removeCollaborators,
            authLevel,
        });
        
        const json = await this.postWecomDocApi({
            path: "/cgi-bin/wedoc/doc_grant_access",
            actionLabel: "doc_grant_access",
            agent,
            body: payload,
        });
        return {
            raw: json,
            docId: readString(docId),
        };
    }

    async getFormInfo(params: { agent: ResolvedAgentAccount; formId: string }) {
        const { agent, formId } = params;
        const normalizedFormId = readString(formId);
        if (!normalizedFormId) throw new Error("formId required");
        const json = await this.postWecomDocApi({
            path: "/cgi-bin/wedoc/form/get_info",
            actionLabel: "get_form_info",
            agent,
            body: { formid: normalizedFormId },
        });
        return {
            raw: json,
            info: json.form_info && typeof json.form_info === "object" ? json.form_info : {},
        };
    }

    async getFormStatistic(params: { agent: ResolvedAgentAccount; formId: string; requests: unknown }) {
        const { agent, requests } = params;
        const payload = Array.isArray(requests)
            ? requests.map((item) => readObject(item)).filter((item) => Object.keys(item).length > 0)
            : [];
        if (payload.length === 0) {
            throw new Error("requests list cannot be empty");
        }
        const json = await this.postWecomDocApi({
            path: "/cgi-bin/wedoc/get_form_statistic",
            actionLabel: "get_form_statistic",
            agent,
            body: { requests: payload },
        });
        const statisticList = readArray(json.statistic_list);
        return {
            raw: json,
            items: statisticList,
            successCount: statisticList.filter((item: any) => Number(item?.errcode ?? 0) === 0).length,
        };
    }

    // --- Content Operations (Enhanced) ---

    async getDocContent(params: { agent: ResolvedAgentAccount; docId: string }) {
        const { agent, docId } = params;
        const json = await this.postWecomDocApi({
            path: "/cgi-bin/wedoc/document/get",
            actionLabel: "get_doc_content",
            agent,
            body: { docid: readString(docId) },
        }) as GetDocContentResponse;
        
        return {
            raw: json,
            version: json.version,
            document: json.document
        };
    }

    /**
     * 更新文档内容（支持批量操作）
     * 
     * 企微官方 API 说明：
     * - 支持批量更新，最多 30 个操作
     * - 所有操作的索引必须基于同一个版本文档快照
     * - 原子性：一个失败则全部回滚
     * - version 与最新版本差值不能超过 100
     * 
     * 使用模式：
     * 1. batchMode=false（默认）：逐个执行，每个操作前自动获取最新版本，可靠性高
     * 2. batchMode=true：一次性批量执行，需要用户确保索引计算正确，性能更好
     */
    async updateDocContent(params: { 
        agent: ResolvedAgentAccount; 
        docId: string; 
        requests: UpdateRequest[]; 
        version?: number;
        batchMode?: boolean;  // 批量模式（默认 false）
    }) {
        const { agent, docId, requests, version, batchMode = false } = params;
        
        const requestList = readArray(requests);
        if (requestList.length === 0) {
             throw new Error("requests list cannot be empty");
        }

        // 批量模式：一次性发送所有请求（需要用户确保索引正确）
        if (batchMode) {
            let currentVersion = version;
            
            // 如果未提供版本号，先获取最新文档
            if (currentVersion === undefined || currentVersion === null) {
                const content = await this.getDocContent({ agent, docId });
                currentVersion = content.version;
            }

            const body: Record<string, unknown> = {
                docid: readString(docId),
                requests: requestList,
                version: currentVersion,
            };
            
            const json = await this.postWecomDocApi({
                path: "/cgi-bin/wedoc/document/batch_update",
                actionLabel: "update_doc_content (batch)",
                agent,
                body,
            }) as BatchUpdateDocResponse;
            
            return { 
                raw: json,
                batchMode: true,
                requestCount: requestList.length
            };
        }

        // 顺序模式（默认）：逐个执行，每次自动获取最新版本号
        // 优点：可靠性高，索引自动修正
        // 缺点：API 调用次数多
        let currentVersion = version;
        
        if (currentVersion === undefined || currentVersion === null) {
            const content = await this.getDocContent({ agent, docId });
            currentVersion = content.version;
        }

        const results = [];
        for (let i = 0; i < requestList.length; i++) {
            const request = requestList[i];
            
            // 每次操作前获取最新文档结构和版本号
            const content = await this.getDocContent({ agent, docId });
            currentVersion = content.version;

            const body: Record<string, unknown> = {
                docid: readString(docId),
                requests: [request],
                version: currentVersion,
            };
            
            let lastErr: any;
            for (let attempt = 1; attempt <= 3; attempt++) {
                try {
                    const json = await this.postWecomDocApi({
                        path: "/cgi-bin/wedoc/document/batch_update",
                        actionLabel: `update_doc_content (${i + 1}/${requestList.length})`,
                        agent,
                        body,
                    }) as BatchUpdateDocResponse;
                    
                    results.push({ index: i, success: true, request });
                    break;
                } catch (err: any) {
                    lastErr = err;
                    if (err.message?.includes("cannot find p") || err.message?.includes("version")) {
                        await new Promise(r => setTimeout(r, 500 * attempt));
                    } else if (attempt < 3) {
                        await new Promise(r => setTimeout(r, 1000));
                    }
                }
            }
            
            if (lastErr) {
                throw new Error(`请求 ${i + 1} 失败：${lastErr.message}`);
            }
        }

        return { 
            raw: { errcode: 0, errmsg: "ok", results },
            batchMode: false,
            executedCount: results.length,
            successCount: results.filter(r => r.success).length
        };
    }

    /**
     * 批量更新文档内容（高级 API）
     * 
     * 自动计算索引，支持链式操作
     * 
     * @example
     * ```typescript
     * // 场景 1：插入多个段落和文本
     * await docClient.batchUpdateDocSmart({
     *     agent, docId,
     *     operations: [
     *         { type: 'paragraph', afterIndex: 0 },
     *         { type: 'text', text: "第一段内容" },
     *         { type: 'paragraph' },
     *         { type: 'text', text: "第二段内容" }
     *     ]
     * });
     * 
     * // 场景 2：插入图片
     * await docClient.batchUpdateDocSmart({
     *     agent, docId,
     *     operations: [
     *         { type: 'paragraph', afterIndex: 10 },
     *         { type: 'image', imageId: "https://...", width: 800 }
     *     ]
     * });
     * ```
     */
    async batchUpdateDocSmart(params: {
        agent: ResolvedAgentAccount;
        docId: string;
        operations: Array<{
            type: 'paragraph' | 'text' | 'image' | 'table';
            text?: string;
            imageId?: string;
            width?: number;
            height?: number;
            rows?: number;
            cols?: number;
            afterIndex?: number;
        }>;
    }) {
        const { agent, docId, operations } = params;
        
        // 获取最新文档结构
        const content = await this.getDocContent({ agent, docId });
        let currentVersion = content.version;
        let currentIndex = operations[0]?.afterIndex ?? 0;

        const results = [];
        for (const op of operations) {
            // 每次操作前获取最新版本
            const latestContent = await this.getDocContent({ agent, docId });
            currentVersion = latestContent.version;

            let request: UpdateRequest;
            
            switch (op.type) {
                case 'paragraph':
                    request = { insert_paragraph: { location: { index: currentIndex } } };
                    break;
                    
                case 'text':
                    request = { insert_text: { location: { index: currentIndex }, text: op.text! } };
                    break;
                    
                case 'image':
                    request = { 
                        insert_image: { 
                            image_id: op.imageId!, 
                            location: { index: currentIndex } 
                        } 
                    };
                    if (op.width) request.insert_image!.width = op.width;
                    if (op.height) request.insert_image!.height = op.height;
                    break;
                    
                case 'table':
                    request = {
                        insert_table: {
                            rows: op.rows || 3,
                            cols: op.cols || 3,
                            location: { index: currentIndex }
                        }
                    };
                    break;
                    
                default:
                    throw new Error(`未知操作类型：${(op as any).type}`);
            }

            const body: Record<string, unknown> = {
                docid: readString(docId),
                requests: [request],
                version: currentVersion,
            };

            const json = await this.postWecomDocApi({
                path: "/cgi-bin/wedoc/document/batch_update",
                actionLabel: `batchUpdateDocSmart (${op.type})`,
                agent,
                body,
            }) as BatchUpdateDocResponse;

            results.push({ type: op.type, success: true });
            currentIndex++;
        }

        return {
            raw: { errcode: 0, errmsg: "ok", results },
            executedCount: results.length
        };
    }

    /**
     * 高级插入文本方法
     * 自动处理段落创建和文本插入
     * 
     * @param params 
     * @param params.agent - 代理账号
     * @param params.docId - 文档 ID
     * @param params.afterIndex - 在哪个索引位置后插入（从 0 开始）
     * @param params.text - 要插入的文本（支持多行）
     * @param params.createParagraphs - 是否自动为每行创建段落（默认 true）
     */
    async insertTextSmart(params: {
        agent: ResolvedAgentAccount;
        docId: string;
        afterIndex: number;
        text: string;
        createParagraphs?: boolean;
    }) {
        const { agent, docId, afterIndex, text, createParagraphs = true } = params;
        
        // 获取最新文档结构
        const content = await this.getDocContent({ agent, docId });
        const version = content.version;
        
        if (createParagraphs) {
            // 按行分割文本
            const lines = text.split('\n').filter(line => line.trim() !== '');
            let currentIndex = afterIndex + 1;
            
            for (const line of lines) {
                // 1. 先创建空段落
                await this.updateDocContent({
                    agent,
                    docId,
                    requests: [{ insert_paragraph: { location: { index: currentIndex } } }],
                    version,
                    smartMode: true,
                });
                
                // 2. 在新段落中插入文本
                await this.updateDocContent({
                    agent,
                    docId,
                    requests: [{ insert_text: { location: { index: currentIndex }, text: line } }],
                    version: undefined,  // smartMode 会自动获取最新版本
                    smartMode: true,
                });
                
                currentIndex++;
            }
            
            return { insertedLines: lines.length };
        } else {
            // 直接插入文本（不创建新段落）
            await this.updateDocContent({
                agent,
                docId,
                requests: [{ insert_text: { location: { index: afterIndex + 1 }, text } }],
                version,
                smartMode: true,
            });
            
            return { insertedText: text };
        }
    }

    /**
     * 插入图片（自动创建空段落）
     */
    async insertImageSmart(params: {
        agent: ResolvedAgentAccount;
        docId: string;
        afterIndex: number;
        imageId: string;
        width?: number;
        height?: number;
    }) {
        const { agent, docId, afterIndex, imageId, width, height } = params;
        
        // 1. 先创建空段落
        const content = await this.getDocContent({ agent, docId });
        const paragraphIndex = afterIndex + 1;
        
        await this.updateDocContent({
            agent,
            docId,
            requests: [{ insert_paragraph: { location: { index: paragraphIndex } } }],
            version: content.version,
            smartMode: true,
        });
        
        // 2. 在空段落中插入图片
        const imageRequest: UpdateRequest = {
            insert_image: {
                image_id: imageId,
                location: { index: paragraphIndex },
            }
        };
        
        if (width) imageRequest.insert_image!.width = width;
        if (height) imageRequest.insert_image!.height = height;
        
        await this.updateDocContent({
            agent,
            docId,
            requests: [imageRequest],
            version: undefined,
            smartMode: true,
        });
        
        return { inserted: true, imageId };
    }

    // --- Spreadsheet Operations ---

    async getSheetProperties(params: { agent: ResolvedAgentAccount; docId: string }) {
        const { agent, docId } = params;
        const normalizedDocId = readString(docId);
        if (!normalizedDocId) throw new Error("docId required");
        const json = await this.postWecomDocApi({
            path: "/cgi-bin/wedoc/spreadsheet/get_sheet_properties",
            actionLabel: "get_sheet_properties",
            agent,
            body: { docid: normalizedDocId },
        });
        return {
            raw: json,
            properties:
                (Array.isArray(json.properties) && json.properties) ||
                (Array.isArray(json.sheet_properties) && json.sheet_properties) ||
                (Array.isArray(json.sheet_list) && json.sheet_list) ||
                [],
        };
    }

    async modDocMemberNotifiedScope(params: { agent: ResolvedAgentAccount; docId: string; notified_scope_type: number; notified_member_list?: any[] }) {
        const { agent, docId, notified_scope_type, notified_member_list } = params;
        const json = await this.postWecomDocApi({
            path: "/cgi-bin/wedoc/mod_doc_member_notified_scope",
            actionLabel: "mod_doc_member_notified_scope",
            agent,
            body: { docid: readString(docId), notified_scope_type, notified_member_list },
        });
        return json;
    }

    async editSheetData(params: { 
        agent: ResolvedAgentAccount; 
        docId: string; 
        sheetId: string;
        startRow?: number;
        startColumn?: number;
        gridData?: any;
    }) {
        const { agent, docId, sheetId, startRow = 0, startColumn = 0, gridData } = params;
        
        const normalizedDocId = readString(docId);
        if (!normalizedDocId) {
            throw new Error('docId is required');
        }
        
        const normalizedSheetId = readString(sheetId);
        if (!normalizedSheetId) {
            throw new Error('sheetId is required');
        }
        
        const rows = (gridData?.rows || []).map((row: any) => ({
            values: (row.values || []).map((cell: any) => {
                if (cell && typeof cell === 'object' && cell.cell_value) {
                    return cell;
                }
                return { cell_value: { text: String(cell ?? '') } };
            })
        }));
        
        const rowCount = rows.length;
        const columnCount = rows.length > 0 ? (rows[0].values?.length || 0) : 0;
        const totalCells = rowCount * columnCount;
        
        if (rowCount > 1000) {
            throw new Error(`行数不能超过 1000，当前：${rowCount}`);
        }
        if (columnCount > 200) {
            throw new Error(`列数不能超过 200，当前：${columnCount}`);
        }
        if (totalCells > 10000) {
            throw new Error(`单元格总数不能超过 10000，当前：${totalCells}`);
        }
        
        const finalGridData = {
            start_row: startRow,
            start_column: startColumn,
            rows: rows
        };
        
        const body = {
            docid: normalizedDocId,
            requests: [{
                update_range_request: {
                    sheet_id: normalizedSheetId,
                    grid_data: finalGridData
                }
            }]
        };
        
        const json = await this.postWecomDocApi({
            path: "/cgi-bin/wedoc/spreadsheet/batch_update",
            actionLabel: "spreadsheet_batch_update",
            agent, body,
        });
        return { 
            raw: json, 
            docId: body.docid as string,
            updatedCells: json.data?.responses?.[0]?.update_range_response?.updated_cells || 0
        };
    }
    
    private buildCellFormat(formatData: any): any {
        const textFormat: any = {};
        
        if (formatData.font != null) {
            textFormat.font = String(formatData.font);
        }
        if (formatData.font_size != null) {
            textFormat.font_size = Math.min(72, Math.max(1, Number(formatData.font_size)));
        }
        if (formatData.bold != null) {
            textFormat.bold = Boolean(formatData.bold);
        }
        if (formatData.italic != null) {
            textFormat.italic = Boolean(formatData.italic);
        }
        if (formatData.strikethrough != null) {
            textFormat.strikethrough = Boolean(formatData.strikethrough);
        }
        if (formatData.underline != null) {
            textFormat.underline = Boolean(formatData.underline);
        }
        if (formatData.color != null && typeof formatData.color === 'object') {
            textFormat.color = {
                red: Math.min(255, Math.max(0, Number(formatData.color.red ?? 0))),
                green: Math.min(255, Math.max(0, Number(formatData.color.green ?? 0))),
                blue: Math.min(255, Math.max(0, Number(formatData.color.blue ?? 0))),
                alpha: Math.min(255, Math.max(0, Number(formatData.color.alpha ?? 255))),
            };
        }
        
        return { text_format: textFormat };
    }

    async uploadDocImage(params: { agent: ResolvedAgentAccount; docId: string; filePath: string }) {
        const { agent, docId, filePath } = params;
        const normalizedDocId = readString(docId);
        if (!normalizedDocId) throw new Error("docId required");
        
        const fileData = await fs.promises.readFile(filePath);
        const base64 = fileData.toString('base64');
        const fileName = filePath.split('/').pop() || 'image.png';
        
        const formData = new FormData();
        formData.append('docid', normalizedDocId);
        formData.append('media', new Blob([fileData], { type: 'image/png' }), fileName);
        
        const token = await getAccessToken(agent);
        const url = `https://qyapi.weixin.qq.com/cgi-bin/wedoc/upload_doc_image?access_token=${encodeURIComponent(token)}`;
        const proxyUrl = resolveWecomEgressProxyUrlFromNetwork(agent.network);
        
        const res = await wecomFetch(url, {
            method: 'POST',
            body: formData,
        }, { proxyUrl, timeoutMs: LIMITS.REQUEST_TIMEOUT_MS });
        
        const json = await parseJsonResponse(res, 'upload_doc_image');
        
        return {
            raw: json,
            url: readString(json.url),
            width: Number(json.width) || 0,
            height: Number(json.height) || 0,
            size: Number(json.size) || 0,
        };
    }
}
