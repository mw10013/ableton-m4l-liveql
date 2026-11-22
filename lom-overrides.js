/**
 * What the LOM docs cannot say, per class, layered over `lom.json` by the
 * schema builder in `liveql-n4m.js`. Pure data.
 *
 * - `scope`: the classes the schema exposes. A member typed by a class outside
 *   it is left out. A class whose `lom.json` parent is in scope inherits the
 *   parent's members, and a parent with subclasses in scope is an interface.
 * - `path`: the GraphQL type of the class's `path`, `String!` unless Live
 *   gives its objects none.
 * - `properties.<name>`: `type`, the GraphQL type when the doc type has no
 *   mapping or the field stays non-null; `default`, the value an absent or
 *   empty read resolves to; `settable`, a member Live sets though the docs say
 *   it cannot be; `description` for the field and `inputDescription` for its
 *   `<Class>SetInput` field; `skip`, why a property is left out;
 *   `dictionary`, a LOM dictionary exposed as the GraphQL object or list
 *   `type` names: Live's key holding the value, or `true` when the
 *   dictionary is the value itself. A settable one is set through the
 *   `<type>Input` input type, or the list type itself.
 * - `children.<name>`: `description`; `index`, the name of a singular
 *   accessor that takes an index into the child list; `list: true`, a child
 *   list whose doc heading names the class without `list of`.
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
const INPUT_ROUTING =
  "Null on tracks with no input routing: Group, return and master tracks.";
const OUTPUT_ROUTING =
  "Null on tracks the LOM does not give it to, such as the master track.";

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
    "Device",
    "SimplerDevice",
    "RackDevice",
    "WavetableDevice",
    "Eq8Device",
    "MaxDevice",
    "DeviceParameter",
    "Chain",
    "DrumChain",
    "DrumPad",
    "ApplicationView",
    "TrackView",
    "TakeLane",
    "DeviceView",
    "RackDeviceView",
    "SimplerDeviceView",
    "Eq8DeviceView",
    "MixerDevice",
    "ChainMixerDevice",
    "Sample",
    "CuePoint",
    "Groove",
    "GroovePool",
    "CompressorDevice",
    "DriftDevice",
    "DrumCellDevice",
    "HybridReverbDevice",
    "LooperDevice",
    "MeldDevice",
    "RoarDevice",
    "ShifterDevice",
    "SpectralResonatorDevice",
    "PluginDevice",
    "TuningSystem",
    "DeviceIO",
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
      drift: {
        tuning_system:
          "documented as a child, info lists a property TuningSystem (Live 12.4.6)",
      },
      children: {
        tuning_system: {
          description: "Its path is null: Live gives the tuning system none.",
        },
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
        delete_track: { args: { index: "Int!" } },
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
        available_input_routing_channels: {
          type: "[RoutingChannel!]",
          dictionary: "available_input_routing_channels",
          description: INPUT_ROUTING,
        },
        available_input_routing_types: {
          type: "[RoutingType!]",
          dictionary: "available_input_routing_types",
          description: INPUT_ROUTING,
        },
        available_output_routing_channels: {
          type: "[RoutingChannel!]",
          dictionary: "available_output_routing_channels",
          description: OUTPUT_ROUTING,
        },
        available_output_routing_types: {
          type: "[RoutingType!]",
          dictionary: "available_output_routing_types",
          description: OUTPUT_ROUTING,
        },
        input_routing_channel: {
          type: "RoutingChannel",
          dictionary: "input_routing_channel",
          description: INPUT_ROUTING,
        },
        input_routing_type: {
          type: "RoutingType",
          dictionary: "input_routing_type",
          description: INPUT_ROUTING,
        },
        output_routing_channel: {
          type: "RoutingChannel",
          dictionary: "output_routing_channel",
          description: OUTPUT_ROUTING,
        },
        output_routing_type: {
          type: "RoutingType",
          dictionary: "output_routing_type",
          description: OUTPUT_ROUTING,
        },
      },
      functions: {
        delete_clip: {
          args: { clip: { type: "Int!", id: true } },
          description:
            "A take lane's clip is left in place without an error. Compare the returned\nclips with what you asked for.",
        },
        insert_device: {
          description:
            "An unknown device_name, or an instrument on a track that already holds one,\nis dropped without an error. Compare the returned devices with what you asked\nfor.",
        },
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
      children: {
        groove: {
          inputDescription:
            "Live ignores 0 here without raising, so this cannot clear a clip's groove.\nCompare the returned has_groove with what you asked for.",
        },
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
    Device: {
      drift: {
        canonical_parent:
          "undocumented, info lists a child Track (Live 12.4.6)",
        type: "documented as int, info says DeviceType (Live 12.4.6)",
      },
      properties: {
        is_using_compare_preset_b: {
          description:
            "Null when can_compare_ab is false: such a device's info leaves it out.",
        },
        type: {
          skip: "the bridge's type field is LiveAPI.type, which this int would overwrite, and class_name and __typename identify the device",
        },
      },
    },
    RackDevice: {
      drift: {
        is_using_compare_preset_b:
          "documented as a property, in no RackDevice's info (Live 12.4.6); absent because no fixture Rack can_compare_ab",
      },
    },
    MaxDevice: {
      drift: {
        is_using_compare_preset_b:
          "documented as a property, in no MaxDevice's info (Live 12.4.6); absent because no fixture Max device can_compare_ab",
      },
    },
    PluginDevice: {
      drift: {
        is_using_compare_preset_b:
          "documented as a property, in no PluginDevice's info (Live 12.4.6); absent because the fixture's AUDelay has can_compare_ab false",
      },
    },
    WavetableDevice: {
      properties: {
        oscillator_1_wavetable_category: { type: "Int" },
        oscillator_2_wavetable_category: { type: "Int" },
        oscillator_1_wavetable_index: { type: "Int" },
        oscillator_2_wavetable_index: { type: "Int" },
      },
      functions: {
        get_modulation_target_parameter_name: {
          skip: "returns a symbol the docs describe only in prose",
        },
        get_modulation_value: {
          skip: "returns a value the docs describe only in prose",
        },
        is_parameter_modulatable: {
          skip: "returns a bool the docs describe only in prose",
        },
        set_modulation_value: {
          skip: "the docs list no parameter for the amount to set",
        },
      },
    },
    DeviceParameter: {
      drift: {
        canonical_parent:
          "undocumented, info lists a child typed by the owning device's class, such as Eq8Device (Live 12.4.6)",
      },
      properties: {
        value_items: {
          description:
            "Null when is_quantized is false: such a parameter's info leaves it out.",
        },
      },
    },
    Chain: {
      drift: {
        canonical_parent:
          "undocumented, info lists a child RackDevice (Live 12.4.6)",
        devices:
          "documented as a child, info lists a children Device (Live 12.4.6)",
      },
      children: { devices: { list: true } },
    },
    DrumPad: {
      drift: {
        canonical_parent:
          "undocumented, info lists a child RackDevice (Live 12.4.6)",
        chains:
          "documented as a child, info lists a children Chain (Live 12.4.6)",
      },
      children: { chains: { list: true } },
    },
    ApplicationView: {
      drift: {
        canonical_parent:
          "undocumented, info lists a child Application (Live 12.4.6)",
      },
      functions: {
        focus_view: { args: { view_name: "String!" } },
        hide_view: { args: { view_name: "String!" } },
        show_view: { args: { view_name: "String!" } },
        scroll_view: {
          args: {
            direction: "Int!",
            view_name: "String!",
            modifier_pressed: "Boolean!",
          },
        },
        zoom_view: {
          args: {
            direction: "Int!",
            view_name: "String!",
            modifier_pressed: "Boolean!",
          },
        },
      },
    },
    TrackView: {
      drift: {
        canonical_parent:
          "undocumented, info lists a child Track (Live 12.4.6)",
        device_insert_mode: "documented as int, info says bool (Live 12.4.6)",
        selected_device:
          "documented as Device, info types it by the selected device's class, such as SpectralResonatorDevice (Live 12.4.6)",
      },
      properties: {
        device_insert_mode: {
          inputDescription:
            "Not the documented 0-2 enum: Live's info types this a bool, and setting 0\nreads back 1 while setting 1 or 2 reads back 0, with no error. Compare the\nreturned value with what you asked for.",
        },
      },
    },
    TakeLane: {
      drift: {
        canonical_parent:
          "undocumented, info lists a child Track (Live 12.4.6)",
      },
    },
    DeviceView: {
      drift: {
        canonical_parent:
          "undocumented, info lists a child typed by the owning device's class, such as RackDevice (Live 12.4.6)",
      },
    },
    RackDeviceView: {
      drift: {
        selected_chain:
          "documented as Chain, info says DrumChain on a Drum Rack and Chain on other Racks (Live 12.4.6)",
      },
    },
    MixerDevice: {
      drift: {
        canonical_parent:
          "undocumented, info lists a child Track (Live 12.4.6)",
      },
    },
    ChainMixerDevice: {
      drift: {
        canonical_parent:
          "undocumented, info lists a child Chain, or DrumChain in a Drum Rack (Live 12.4.6)",
      },
    },
    Sample: {
      drift: {
        canonical_parent:
          "undocumented, info lists a child SimplerDevice (Live 12.4.6)",
        sample_rate: "documented as int, info says float (Live 12.4.6)",
        slices: "documented as list of int, info says tuple (Live 12.4.6)",
      },
      properties: {
        slices: { type: "[Int!]" },
      },
    },
    CuePoint: {
      drift: {
        canonical_parent: "undocumented, info lists a child Song (Live 12.4.6)",
      },
    },
    Groove: {
      drift: {
        canonical_parent:
          "undocumented, info lists a child GroovePool (Live 12.4.6)",
      },
    },
    GroovePool: {
      drift: {
        canonical_parent: "undocumented, info lists a child Song (Live 12.4.6)",
      },
    },
    TuningSystem: {
      path: "String",
      drift: {
        canonical_parent: "undocumented, info lists a child Song (Live 12.4.6)",
      },
      properties: {
        lowest_note: {
          type: "TuningNote",
          dictionary: true,
          inputDescription:
            "Live also moves highest_note by the same number of notes, keeping the\nrange's span, without saying so. Set highest_note after lowest_note to\nplace both.",
        },
        highest_note: { type: "TuningNote", dictionary: true },
        reference_pitch: { type: "ReferencePitch", dictionary: true },
        note_tunings: {
          type: "[Float!]",
          dictionary: "note_tunings",
          description: "The cents of each note of the pseudo octave.",
        },
      },
    },
    DeviceIO: {
      drift: {
        canonical_parent:
          "undocumented, info lists a child MaxDevice (Live 12.4.6)",
      },
      properties: {
        available_routing_channels: {
          type: "[RoutingChannel!]",
          dictionary: "available_routing_channels",
        },
        available_routing_types: {
          type: "[RoutingType!]",
          dictionary: "available_routing_types",
        },
        routing_channel: {
          type: "RoutingChannel",
          dictionary: "routing_channel",
        },
        routing_type: { type: "RoutingType", dictionary: "routing_type" },
      },
    },
    CompressorDevice: {
      properties: {
        available_input_routing_channels: {
          type: "[RoutingChannel!]",
          dictionary: "available_input_routing_channels",
        },
        available_input_routing_types: {
          type: "[RoutingType!]",
          dictionary: "available_input_routing_types",
        },
        input_routing_channel: {
          type: "RoutingChannel",
          dictionary: "input_routing_channel",
        },
        input_routing_type: {
          type: "RoutingType",
          dictionary: "input_routing_type",
        },
      },
    },
    MeldDevice: {
      drift: {
        selected_engine: "documented as int, info says bool (Live 12.4.6)",
      },
    },
  },
};
