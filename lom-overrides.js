/**
 * What the LOM docs cannot say, per class, layered over `lom.json` by the
 * schema builder in `liveql-n4m.js`. Pure data.
 *
 * - `scope`: the classes the schema exposes. A member typed by a class outside
 *   it is left out.
 * - `properties.<name>`: `type`, the GraphQL type when the doc type has no
 *   mapping or the field stays non-null; `default`, the value an absent or
 *   empty read resolves to; `settable`, a member Live sets though the docs say
 *   it cannot be; `description` for the field and `inputDescription` for its
 *   `<Class>SetInput` field.
 * - `children.<name>`: `description`, and `index`, the name of a singular
 *   accessor that takes an index into the child list.
 * - `functions.<name>`: `args`, the GraphQL arguments in LOM call order, each
 *   an SDL type with an optional default or `{ type, id: true }` for an object
 *   passed by id, replacing what the docs give; `description`; `field`, the
 *   GraphQL type of a function exposed as a lazily called field instead of a
 *   mutation; `custom`, a function `liveql-n4m.js` writes by hand; `skip`, why
 *   a function is left out.
 * - `drift.<name>`: where Live's `info` disagrees with the docs for a member
 *   (undocumented, absent from every object, or another type), as the `test:live`
 *   drift check prints it. The schema builder ignores it; the row records that
 *   a human has seen the mismatch.
 */
module.exports = {
  scope: [
    "Application",
    "Song",
    "SongView",
    "Track",
    "ClipSlot",
    "Scene",
    "Clip",
    "ClipView",
  ],
  classes: {
    Application: {
      functions: {
        get_major_version: { field: "Int!" },
        get_minor_version: { field: "Int!" },
        get_bugfix_version: { field: "Int!" },
        get_version_string: { field: "String!" },
      },
    },
    Song: {
      children: {
        tracks: { index: "track" },
        scenes: { index: "scene" },
      },
      properties: {
        name: {
          type: "String!",
          default: "",
          description: "Empty string for a Set that has never been saved.",
        },
        file_path: {
          type: "String!",
          default: "",
          description: "Empty string for a Set that has never been saved.",
        },
        scale_name: { type: "String!", default: "" },
        scale_intervals: { type: "[Int!]" },
      },
      functions: {
        stop_all_clips: { args: { quantized: "Boolean = true" } },
        capture_midi: { args: { destination: "Int = 0" } },
        create_midi_track: { args: { index: "Int = -1" } },
        create_scene: { args: { index: "Int = -1" } },
      },
    },
    SongView: {
      drift: {
        canonical_parent: "undocumented, info lists a child Song (Live 12.4.6)",
      },
    },
    Track: {
      drift: {
        canonical_parent: "undocumented, info lists a child Song (Live 12.4.6)",
        fold_state: "documented as int, info says bool (Live 12.4.6)",
      },
      children: {
        group_track: {
          description: "Null when the track is not inside a Group Track.",
        },
        clip_slots: { index: "clip_slot" },
        arrangement_clips: { index: "arrangement_clip" },
      },
      properties: {
        name: { type: "String!", default: "" },
        arm: {
          description:
            "Null on tracks the LOM does not give it to, such as return and master tracks.",
        },
        mute: {
          description:
            "Null on tracks the LOM does not give it to, such as the master track.",
        },
        solo: {
          description:
            "Null on tracks the LOM does not give it to, such as the master track.",
        },
        fold_state: {
          description:
            "Null unless is_foldable: only Group Tracks have a fold state.",
        },
        playing_slot_index: {
          description:
            "Null on tracks with no clip slots, such as return and master tracks.",
        },
        fired_slot_index: {
          description:
            "Null on tracks with no clip slots, such as return and master tracks.",
        },
      },
      functions: {
        delete_clip: { args: { clip: { type: "Int!", id: true } } },
        duplicate_clip_slot: { args: { index: "Int!" } },
        duplicate_clip_to_arrangement: {
          args: {
            clip: { type: "Int!", id: true },
            destination_time: "Float!",
          },
        },
      },
    },
    ClipSlot: {
      drift: {
        canonical_parent:
          "undocumented, info lists a child Track (Live 12.4.6)",
        playing_status:
          "documented as int, info says ClipSlotPlayingState (Live 12.4.6)",
      },
      properties: {
        color: {
          description:
            "Null outside Group Track slots, which are the only slots the LOM colors.",
        },
      },
      functions: {
        fire: {
          args: { record_length: "Float", launch_quantization: "Int" },
          description:
            "The LOM takes these optional arguments positionally, so launch_quantization\nwithout record_length is rejected with an error naming the missing one.",
        },
        create_clip: { args: { length: "Float!" } },
      },
    },
    Scene: {
      drift: {
        canonical_parent: "undocumented, info lists a child Song (Live 12.4.6)",
      },
      properties: {
        name: { type: "String!", default: "" },
      },
      functions: {
        fire: {
          description:
            "The LOM takes these optional arguments positionally, so\ncan_select_scene_on_launch without force_legato is rejected with an error\nnaming the missing one.",
        },
      },
    },
    Clip: {
      drift: {
        canonical_parent:
          "undocumented, info lists a child Track (Live 12.4.6)",
        is_session_clip:
          "documented as a property, in no Clip's info (Live 12.4.6)",
        is_take_lane_clip:
          "documented as a property, in no Clip's info (Live 12.4.6)",
      },
      properties: {
        name: { type: "String!", default: "" },
        loop_start: {
          inputDescription:
            "Live drops a loop_start set past the current loop_end without raising.\nOrder the items so start stays <= end, and compare the returned clip with\nwhat you asked for.",
        },
        loop_end: {
          inputDescription:
            "Live drops a loop_end set before the current loop_start without raising.\nOrder the items so start stays <= end, and compare the returned clip with\nwhat you asked for.",
        },
        start_marker: {
          inputDescription:
            "Live drops a start_marker set past the current end_marker without raising.\nOrder the items so start stays <= end, and compare the returned clip with\nwhat you asked for.",
        },
        end_marker: {
          inputDescription:
            "Live drops an end_marker set before the current start_marker without\nraising. Order the items so start stays <= end, and compare the returned\nclip with what you asked for.",
        },
        position: { settable: true },
      },
      functions: {
        get_all_notes_extended: { custom: true },
        get_notes_by_id: { custom: true },
        get_notes_extended: { custom: true },
        get_selected_notes_extended: { custom: true },
        add_new_notes: { custom: true },
        apply_note_modifications: { custom: true },
        duplicate_notes_by_id: { custom: true },
        add_warp_marker: {
          skip: "takes a warp marker dict the docs describe only in prose",
        },
        select_notes_by_id: { args: { note_ids: "[Int!]!" } },
        remove_notes_by_id: { args: { note_ids: "[Int!]!" } },
        duplicate_region: {
          args: {
            region_start: "Float!",
            region_length: "Float!",
            destination_time: "Float!",
            pitch: "Int = -1",
            transposition_amount: "Int = 0",
          },
        },
        /**
         * The LOM documents no int mapping for `quantization_grid`. Measured in
         * Live by quantizing notes off every grid and reading where they land, it
         * is Live's Quantize dialog in menu order: 0 no quantization, 1 = 1/4,
         * 2 = 1/8, 3 = 1/8T, 4 = 1/8 + 1/8T, 5 = 1/16, 6 = 1/16T,
         * 7 = 1/16 + 1/16T, 8 = 1/32. Anything from 9 up is silently ignored, so a
         * caller gets no error for an out-of-range grid, just an unquantized clip.
         * This is NOT the Clip.View.grid_quantization enum, which takes 0-9.
         */
        quantize: {
          description:
            "Live's Quantize dialog in menu order: 0 = no quantization, 1 = 1/4,\n2 = 1/8, 3 = 1/8T, 4 = 1/8 + 1/8T, 5 = 1/16, 6 = 1/16T, 7 = 1/16 + 1/16T,\n8 = 1/32. Anything from 9 up is silently ignored, so an out-of-range grid\ngives no error and an unquantized clip. Not the ClipView.grid_quantization\nenum. Quantizing takes Song.swing_amount into account.",
        },
        quantize_pitch: {
          description:
            "Live's Quantize dialog in menu order: 0 = no quantization, 1 = 1/4,\n2 = 1/8, 3 = 1/8T, 4 = 1/8 + 1/8T, 5 = 1/16, 6 = 1/16T, 7 = 1/16 + 1/16T,\n8 = 1/32. Anything from 9 up is silently ignored, so an out-of-range grid\ngives no error and an unquantized clip. Not the ClipView.grid_quantization\nenum. Quantizing takes Song.swing_amount into account.",
        },
      },
    },
    ClipView: {
      drift: {
        canonical_parent: "undocumented, info lists a child Clip (Live 12.4.6)",
      },
      properties: {
        /**
         * The LOM says only "Get/set the grid quantization" for
         * Clip.View.grid_quantization. It is Off plus the nine Fixed Grid entries,
         * coarse to fine: 0 = Off (the
         * editor's Snap to Grid unchecked), 1 = 8 Bars, 2 = 4 Bars, 3 = 2 Bars,
         * 4 = 1 Bar, 5 = 1/2, 6 = 1/4, 7 = 1/8, 8 = 1/16, 9 = 1/32. Anything
         * outside 0-9 is ignored and leaves the current value. 0, 5 and 9 were read
         * directly off the grid label in Live's note editor; the rest follow from
         * the count and the order of the menu. The menu's Adaptive
         * Grid entries are not reachable through this property, and Triplet Grid is
         * the separate grid_is_triplet bool. This enum is not the one
         * `clip_quantize` takes.
         */
        grid_quantization: {
          description:
            "The editor's grid, as Off plus Live's nine Fixed Grid entries, coarse to\nfine: 0 = Off (Snap to Grid unchecked), 1 = 8 Bars, 2 = 4 Bars, 3 = 2 Bars,\n4 = 1 Bar, 5 = 1/2, 6 = 1/4, 7 = 1/8, 8 = 1/16, 9 = 1/32. Anything outside\n0-9 is ignored and leaves the current value, with no error. The menu's\nAdaptive Grid entries are not reachable here. This is NOT the enum\nclip_quantize takes: a 1/16 grid is 8 here and 5 there.",
        },
        grid_is_triplet: {
          description:
            "Live's Triplet Grid toggle, which the grid_quantization enum has no values for.",
        },
      },
    },
  },
};
