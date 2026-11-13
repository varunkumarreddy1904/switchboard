import type { FastifyPluginAsync, FastifyReply } from 'fastify'
import { graphError, type GraphResult, type SandboxWorld } from './world'

/**
 * Graph-API-compatible facade. Point a Cloud API client's base URL at `<host>/graph`
 * instead of https://graph.facebook.com and it behaves like a (strict) test WABA.
 */
export function graphRoutes(world: SandboxWorld): FastifyPluginAsync {
  return async (app) => {
    const send = (reply: FastifyReply, r: GraphResult) => reply.code(r.status).send(r.body)

    app.addHook('onRequest', async (req, reply) => {
      const auth = req.headers.authorization ?? ''
      if (auth !== `Bearer ${world.business.accessToken}`) {
        return send(reply, graphError(401, 190, 'Invalid OAuth access token - Cannot parse access token'))
      }
      const ver = (req.params as { ver?: string } | undefined)?.ver ?? req.url.split('/')[2]
      if (ver && !/^v\d+\.\d+$/.test(ver)) return send(reply, graphError(400, 2500, `Unknown path components: /${ver}`))
    })

    type P = { ver: string; id: string }

    // Media uploads are multipart, like Meta's. Parsed with the platform's own FormData reader.
    app.addContentTypeParser('multipart/form-data', { parseAs: 'buffer', bodyLimit: 20 * 1024 * 1024 }, (_req, body, done) => done(null, body))
    app.post<{ Params: P }>('/:ver/:id/media', async (req, reply) => {
      let form: FormData
      try {
        form = await new Response(new Uint8Array(req.body as Buffer), { headers: { 'content-type': String(req.headers['content-type'] ?? '') } }).formData()
      } catch {
        return send(reply, graphError(400, 100, '(#100) Expected multipart/form-data with messaging_product, type and file'))
      }
      const file = form.get('file')
      const blob = file instanceof Blob ? file : null
      return send(
        reply,
        world.graphUploadMedia(req.params.id, {
          messagingProduct: form.get('messaging_product') as string | null,
          type: form.get('type') as string | null,
          bytes: blob ? Buffer.from(await blob.arrayBuffer()) : null,
          fileType: blob?.type ?? null,
        }),
      )
    })
    // The download URL GET /{media-id} hands out. Needs the bearer token, as Meta's does.
    app.get<{ Params: { ver: string; mid: string } }>('/:ver/_media/:mid', async (req, reply) => {
      const m = world.mediaBytes(req.params.mid)
      if (!m) return send(reply, graphError(404, 100, 'Media not found or expired'))
      return reply.type(m.mime).send(m.bytes)
    })

    app.post<{ Params: P }>('/:ver/:id/messages', async (req, reply) => send(reply, world.graphSendMessage(req.params.id, req.body)))
    app.post<{ Params: P }>('/:ver/:id/groups', async (req, reply) => send(reply, world.graphCreateGroup(req.params.id, req.body)))
    app.get<{ Params: P }>('/:ver/:id/groups', async (req, reply) => send(reply, world.graphListGroups(req.params.id)))
    app.get<{ Params: P }>('/:ver/:id/invite_link', async (req, reply) => send(reply, world.graphInviteLink(req.params.id)))
    app.delete<{ Params: P }>('/:ver/:id/participants', async (req, reply) => send(reply, world.graphRemoveParticipants(req.params.id, req.body)))
    app.get<{ Params: P }>('/:ver/:id/message_templates', async (req, reply) => send(reply, world.graphListTemplates(req.params.id)))
    app.post<{ Params: P }>('/:ver/:id/message_templates', async (req, reply) => send(reply, world.graphCreateTemplate(req.params.id, req.body)))
    app.get<{ Params: P; Querystring: { fields?: string } }>('/:ver/:id', async (req, reply) => {
      const media = world.graphMediaInfo(req.params.id, `${req.protocol}://${req.headers.host}/graph/${req.params.ver}`)
      if (media) return send(reply, media)
      return send(reply, world.graphGetObject(req.params.id, (req.query.fields ?? '').split(',').filter(Boolean)))
    })
  }
}
