import { mkdir } from 'fs/promises'
import { stat } from 'fs/promises'
import { AutoRouter, html, json } from 'itty-router'
import OpenAI from 'openai'

const port = parseInt(Bun.env.PORT || '3000')
if (isNaN(port)) throw new Error('Invalid port number')

const ai = new OpenAI({
	apiKey: Bun.env.OPENAI_API_KEY,
})

const storagePath = Bun.env.STATIC_PATH || './static'
await stat(storagePath).catch(() => mkdir(storagePath))

const index = await Bun.file('./index.html').text()

export default AutoRouter({ port })
	.get('/', () => html(index))
	.get('/:name.svg', async ({ params }) => {
		const { name } = params
		const filename = `${name}.svg`

		const file = Bun.file(`${storagePath}/${filename}`)
		if (!(await file.exists())) return json({ error: 'File not found' }, { status: 404 })

		return new Response(file, {
			headers: {
				'Content-Type': 'image/svg+xml',
				'Cache-Control': 'public, max-age=31536000, immutable',
			},
		})
	})
	.get('/api/generate', ({ query }) => handleGenerate(query.name, query.key))
	.get('/api/:name.svg', ({ params, query }) => handleGenerate(params.name, query.key))

type Query = string | string[] | undefined
async function handleGenerate(name: Query, key: Query) {
	if (typeof name !== 'string') return json({ error: 'Filename not provided' }, { status: 400 })

	name = decodeURIComponent(name).replace(/[^a-zA-Z0-9_-]/g, '_')

	if (name.length < 3) return json({ error: 'Filename too short' }, { status: 400 })
	if (name.length > 100) return json({ error: 'Filename too long' }, { status: 400 })

	const filename = `${name}.svg`

	const file = Bun.file(`${storagePath}/${filename}`)
	if (!(await file.exists())) {
		if (Bun.env.SECRET_KEY && (typeof key !== 'string' || key !== Bun.env.SECRET_KEY))
			return json({ error: 'Invalid key' }, { status: 401 })

		const content = await generateSVG(name)

		if (!content?.startsWith('<svg'))
			return json({ error: 'Invalid SVG content', content }, { status: 400 })

		await Bun.write(file, content)
	}

	return new Response(null, {
		status: 302,
		headers: {
			Location: `/${filename}`,
		},
	})
}

async function generateSVG(filename: string, fast = false): Promise<string | undefined> {
	const response = await ai.chat.completions.create({
		model: fast ? 'gpt-3.5-turbo' : 'gpt-4o',
		messages: [
			{
				role: 'system',
				content: 'You are creating SVG files based on filename provided by the user.',
			},
			{ role: 'user', content: filename },
		],
		tool_choice: 'required',
		tools: [
			{
				type: 'function',
				function: {
					name: 'respond_with_file',
					parameters: {
						type: 'object',
						properties: {
							content: {
								type: 'string',
							},
						},
						required: ['content'],
					},
				},
			},
		],
	})

	const content = response.choices[0].message.tool_calls?.[0].function.arguments
	return JSON.parse(content || '{}').content?.replace(/^.*(?=<svg)|(?<=<\/svg>).*$/g, '')
}
