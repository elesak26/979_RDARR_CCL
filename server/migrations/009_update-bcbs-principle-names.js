/**
 * Migration 007 – Normalise bcbs_principle_name values across all questions.
 * Changes:
 *  - Separator for multi-principle questions changed from newline to ' | '
 *  - Casing fixed to match the authoritative Excel (v3): Integrity, Architecture, Usefulness
 *  - Item 23: Timeliness added (was missing in previous seed)
 */

exports.up = (pgm) => {
  pgm.sql(`
    -- Items 18-20: Data Architecture & IT Infrastructure (fix casing)
    UPDATE questions
    SET bcbs_principle_name = 'Data Architecture & IT Infrastructure'
    WHERE item_number IN (18, 19, 20);

    -- Items 21, 22, 23, 26, 27: three-principle group (item 23 gains Timeliness)
    UPDATE questions
    SET bcbs_principle_name = 'Accuracy and Integrity | Completeness | Timeliness'
    WHERE item_number IN (21, 22, 23, 26, 27);

    -- Items 24, 25, 28: single principle (fix casing: integrity → Integrity)
    UPDATE questions
    SET bcbs_principle_name = 'Accuracy and Integrity'
    WHERE item_number IN (24, 25, 28);

    -- Item 32: two-principle (Governance + Data Architecture)
    UPDATE questions
    SET bcbs_principle_name = 'Governance | Data Architecture & IT Infrastructure'
    WHERE item_number = 32;

    -- Items 38, 39: Clarity and Usefulness (fix casing: usefulness → Usefulness)
    UPDATE questions
    SET bcbs_principle_name = 'Clarity and Usefulness'
    WHERE item_number IN (38, 39);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    UPDATE questions SET bcbs_principle_name = 'Data architecture & IT Infrastructure' WHERE item_number IN (18, 19, 20);
    UPDATE questions SET bcbs_principle_name = 'Accuracy and integrity' || E'\\n' || 'Completeness' || E'\\n' || 'Timeliness' WHERE item_number IN (21, 22, 26, 27);
    UPDATE questions SET bcbs_principle_name = 'Accuracy and integrity' || E'\\n' || 'Completeness' WHERE item_number = 23;
    UPDATE questions SET bcbs_principle_name = 'Accuracy and integrity' WHERE item_number IN (24, 25, 28);
    UPDATE questions SET bcbs_principle_name = 'Governance ' || E'\\n' || 'Data architecture & IT Infrastructure' WHERE item_number = 32;
    UPDATE questions SET bcbs_principle_name = 'Clarity and usefulness' WHERE item_number IN (38, 39);
  `);
};
