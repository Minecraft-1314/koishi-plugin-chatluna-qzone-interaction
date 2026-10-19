import { publishQzonePost } from './index'

export { publishQzonePost }

import type { Context } from 'koishi'
import type { PublishImageInput, PostMutationResult } from 'qzone-sdk'

export interface PublishTarget {
    publishPost(request: {
        content: string
        images?: readonly PublishImageInput[]
    }): Promise<PostMutationResult>
}

export interface PublishContext {
    readonly http: Context['http']
    readonly logger: Context['logger']
    readonly target: PublishTarget
}

export const readPublishTarget = (ctx: Context): PublishTarget | null => {
    const service = ctx.get('chatluna_qzone_interaction' as never) as
        | Partial<PublishTarget>
        | undefined
    if (service == null) return null
    if (typeof service.publishPost !== 'function') return null
    return service as PublishTarget
}

export const createPublishContext = (
    ctx: Context
): PublishContext | null => {
    const target = readPublishTarget(ctx)
    if (target === null) return null
    return { http: ctx.http, logger: ctx.logger, target }
}
