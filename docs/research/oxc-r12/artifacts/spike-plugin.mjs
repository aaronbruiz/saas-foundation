const selector =
  "MemberExpression:matches([property.name='raw'], [property.value='raw']):matches([object.name='sql'], [object.property.name='sql'])"
export default {
  meta: { name: 'spike' },
  rules: {
    'no-raw-sql': {
      create(context) {
        return {
          [selector](node) {
            context.report({ node, message: 'No sql.raw (ADR-0040)' })
          },
        }
      },
    },
  },
}
