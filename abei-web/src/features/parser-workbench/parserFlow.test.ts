import { describe, expect, it } from 'vitest'
import { NODE_TEMPLATES, addNode, emptyFlow, flowYaml, moveNode, parseFlow, parseNode } from './parserFlow'

describe('parser flow editor', () => {
  it('round-trips the structured flow through YAML', () => {
    const source = flowYaml(emptyFlow())
    const parsed = parseFlow(source)
    expect(parsed.error).toBeNull()
    expect(parsed.definition?.nodes).toHaveLength(3)
  })

  it('uses unique node ids and reorders without mutation', () => {
    const original = emptyFlow()
    const added = addNode(addNode(original, 'parse_money'), 'parse_money')
    expect(added.nodes.at(-2)?.id).toBe('parse-money')
    expect(added.nodes.at(-1)?.id).toBe('parse-money-2')
    expect(moveNode(added, 1, -1).nodes[0]?.id).toBe('extract')
    expect(original.nodes[0]?.id).toBe('select')
  })

  it('rejects scalar nodes', () => {
    expect(() => parseNode('hello')).toThrow('节点必须是对象')
  })

  it('exposes every server parser node in the workbench', () => {
    expect(NODE_TEMPLATES.map((item) => item.type)).toEqual(expect.arrayContaining([
      'first_available',
      'extract_links',
      'download',
      'switch',
      'group_rows',
      'split_rows',
      'whitespace_table',
    ]))
  })
})
