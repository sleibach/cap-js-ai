const enhancedFlag = 'sap.cds.recommendations';

function enhanceModel(model) {
  if (model.meta.flavor !== 'inferred' || model.meta[enhancedFlag]) return;

  for (const name in model.definitions) {
    const entity = model.definitions[name];
    if (!entity['@odata.draft.enabled']) {
      continue;
    }
    enhanceEntity(name, model);
    // Walk composition children recursively. In legacy CSN flavours the
    // compositions are exposed under `entity.compositions`; in current
    // (CDS >= 7) CSN they are part of `entity.elements` with
    // `type === 'cds.Composition'`. enhanceEntity itself is idempotent
    // (it bails if `@UI.Recommendations` is already set), so duplicate
    // visits are safe; the visited set is just a micro-optimisation and
    // a guard against composition cycles.
    const visited = new Set([name]);
    const walk = (entityName) => {
      const e = model.definitions[entityName];
      if (!e) return;
      if (e.compositions) {
        for (const comp in e.compositions) {
          const tgt = e.compositions[comp].target;
          if (tgt && !visited.has(tgt)) {
            visited.add(tgt);
            enhanceEntity(tgt, model);
            walk(tgt);
          }
        }
      }
      if (e.elements) {
        for (const ele in e.elements) {
          const def = e.elements[ele];
          if (def.type === 'cds.Composition' && def.target && !visited.has(def.target)) {
            visited.add(def.target);
            enhanceEntity(def.target, model);
            walk(def.target);
          }
        }
      }
    };
    walk(name);
  }
  model.meta[enhancedFlag] = true;
}

/**
 *
 * @param {string} name Name of entity
 * @param {CSN} model
 */
function enhanceEntity(name, model) {
  const entity = model.definitions[name];
  if (entity['@UI.Recommendations']) return; // already enhanced
  const vhFields = Object.keys(entity.elements).reduce((vhFields, ele) => {
    // check if the property has a value help
    const hasValueHelp =
      entity.elements[ele]['@Common.ValueList.CollectionPath'] ||
      model.definitions[entity.elements[ele].target]?.['@cds.odata.valuelist'];
    if (entity.elements[ele]['@UI.RecommendationState'] !== 0 && hasValueHelp) {
      if (entity.elements[ele].keys) {
        for (const key of entity.elements[ele].keys) {
          vhFields[ele + '_' + key.ref.join('_')] = structuredClone(
            model.definitions[entity.elements[ele].target].elements[key.ref]
          );
          delete vhFields[ele + '_' + key.ref.join('_')].key;
        }
      } else if (!entity.elements[ele].on) {
        vhFields[ele] = structuredClone(entity.elements[ele]);
        delete vhFields[ele].key;
      }
    }
    return vhFields;
  }, {});
  if (Object.keys(vhFields).length > 0) {
    entity.elements['SAP_Recommendations'] = {
      type: 'cds.Association',
      cardinality: { max: 1 },
      on: [{ val: 1 }, '=', { val: 1 }],
      target: name + '_Recommendations'
    };
    const cqn = entity.projection ?? entity.query.SELECT;
    cqn.columns ??= ['*'];
    cqn.columns.push({
      cast: {
        type: 'cds.Association',
        cardinality: { max: 1 },
        on: [{ val: 1 }, '=', { val: 1 }],
        target: name + '_Recommendations'
      },
      as: 'SAP_Recommendations'
    });
    entity['@UI.Recommendations'] = { '=': 'SAP_Recommendations' };
    model.definitions[name + '_Recommendations'] = {
      kind: 'entity',
      '@cds.persistence.skip': true,
      elements: Object.keys(vhFields).reduce(
        (acc, fieldWithRecommendations) => {
          acc[fieldWithRecommendations] = {
            virtual: true,
            items: {
              elements: {
                RecommendedFieldValue: vhFields[fieldWithRecommendations],
                RecommendedFieldDescription: { type: 'cds.String' },
                RecommendedFieldScoreValue: { type: 'cds.Decimal' },
                RecommendedFieldIsSuggestion: { type: 'cds.Boolean' }
              }
            }
          };
          return acc;
        },
        { technicalRecommendationsIdentifier: { key: true, type: 'cds.UUID' } }
      )
    };
  }
}

export default enhanceModel;
