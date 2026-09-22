// GENERATED FILE — DO NOT EDIT BY HAND.
//
//     source:    dev/fixtures/bubble-engine-parity.json
//     generator: dev/generate-garmin-parity-fixture.js
//     regenerate: node dev/generate-garmin-parity-fixture.js
//
// The fixture is one file read by three engines: the JavaScript one it was
// recorded from (dev/bubble-engine-parity.test.js), the Swift wrist engine
// (ios/WatchBubbleEngine/Tests/.../BubbleEngineParityTests.swift, which
// walks up to the same path), and this one. Monkey C cannot read a file, so
// this table is the fixture compiled in — and `npm run test:garmin` fails if
// it has fallen behind the JSON.
//
// Numbers are STRINGS parsed with toDouble() at runtime: a bare decimal
// literal in Monkey C is a 32-bit Float, and a nine-significant-digit
// latitude compared at a 1e-7 tolerance cannot survive that.
//
// Annotated (:parity) so it is excluded from every ordinary build — see
// monkey.jungle. It is compiled only by `CIQ_PARITY=1 ./build.sh build`.
(:parity)
module GarminParityFixture {

    function bubbleEngineVersion() { return "bubble-engine-v2"; }

    // Per-field, because 0.1 means different things to a metre, a degree
    // and a latitude. Same four the other two harnesses use.
    function toleranceMetres()    { return "0.1"; }
    function toleranceDegrees()   { return "0.01"; }
    function toleranceDistanceM() { return "0.5"; }
    function toleranceCoord()     { return "1e-7"; }

    function count() { return 11; }

    function caseAt(index) {
        if (index == 0) { return case0(); }
        if (index == 1) { return case1(); }
        if (index == 2) { return case2(); }
        if (index == 3) { return case3(); }
        if (index == 4) { return case4(); }
        if (index == 5) { return case5(); }
        if (index == 6) { return case6(); }
        if (index == 7) { return case7(); }
        if (index == 8) { return case8(); }
        if (index == 9) { return case9(); }
        if (index == 10) { return case10(); }
        return null;
    }
    // mid-iron approach
    // The ordinary case, and the baseline every other case is read against: a
    // real account bag, a saved My Bubble, a target inside comfortable range.
    function case0() {
        return {
            "name" => "mid-iron approach",
            "bag" => [
                ["Driver", "205", "228"],
                ["3W", "190", "209"],
                ["5i", "155", "167"],
                ["7i", "138", "148"],
                ["9i", "118", "127"],
                ["PW", "103", "108"]
            ],
            "ghostBag" => false,
            "offsetDeg" => "3.2",
            "handedness" => "right",
            "green" => ["-36.9169", "174.7393"],
            "route" => [
                ["-36.9134", "174.7411"],
                ["-36.9145", "174.7403"],
                ["-36.9157", "174.7398"],
                ["-36.9169", "174.7393"]
            ],
            "player" => ["-36.9157", "174.7398"],
            "target" => ["-36.9169", "174.7393"],
            "expect" => {
                "defaultTarget" => ["-36.9169", "174.7393"],
                "targetDistanceM" => "140.643",
                "shotBearingDeg" => "198.42",
                "club" => "7i",
                "carryM" => "138",
                "totalM" => "148",
                "aimOffsetDeg" => "3.2",
                "visualWidthM" => "22",
                "visualDepthM" => "28.8",
                "visualTiltDeg" => "6.71",
                "bubbleCentre" => ["-36.9168751", "174.7392173"],
                "ringResolution" => 168,
                "ringSample" => [
                    ["-36.9169619", "174.7391535"],
                    ["-36.9168908", "174.7390705"],
                    ["-36.9168105", "174.7390735"],
                    ["-36.9167679", "174.7391607"],
                    ["-36.9167882", "174.7392812"],
                    ["-36.9168594", "174.7393642"],
                    ["-36.9169397", "174.7393611"],
                    ["-36.9169821", "174.7392738"]
            ]
            }
        };
    }

    // ghost-bag
    // With no account bag the engine falls back to its own stand-in carries
    // and tags the answer ghostBag. That tag has to cross: a Bubble built on a
    // ghost bag is a stand-in, and the wrist must be able to say so rather
    // than presenting invented distances as the player's own.
    function case1() {
        return {
            "name" => "ghost-bag",
            "bag" => [
                ["Driver", "230", "255"],
                ["3W", "205", "226"],
                ["4H", "180", "198"],
                ["4i", "178", "191"],
                ["5i", "170", "183"],
                ["6i", "160", "172"],
                ["7i", "155", "167"],
                ["8i", "142", "153"],
                ["9i", "130", "140"],
                ["PW", "115", "120"],
                ["GW", "98", "103"],
                ["SW", "82", "86"],
                ["LW", "66", "69"]
            ],
            "ghostBag" => true,
            "offsetDeg" => "3.2",
            "handedness" => "right",
            "green" => ["-36.9169", "174.7393"],
            "route" => [
                ["-36.9134", "174.7411"],
                ["-36.9145", "174.7403"],
                ["-36.9157", "174.7398"],
                ["-36.9169", "174.7393"]
            ],
            "player" => ["-36.9157", "174.7398"],
            "target" => ["-36.9169", "174.7393"],
            "expect" => {
                "defaultTarget" => ["-36.9169", "174.7393"],
                "targetDistanceM" => "140.643",
                "shotBearingDeg" => "198.42",
                "club" => "9i",
                "carryM" => "130",
                "totalM" => "140",
                "aimOffsetDeg" => "3.2",
                "visualWidthM" => "20.7",
                "visualDepthM" => "27.2",
                "visualTiltDeg" => "6.71",
                "bubbleCentre" => ["-36.916875", "174.7392174"],
                "ringResolution" => 168,
                "ringSample" => [
                    ["-36.916957", "174.739157"],
                    ["-36.9168899", "174.7390787"],
                    ["-36.916814", "174.7390815"],
                    ["-36.9167737", "174.739164"],
                    ["-36.9167928", "174.7392778"],
                    ["-36.91686", "174.7393562"],
                    ["-36.916936", "174.7393532"],
                    ["-36.9169761", "174.7392707"]
            ]
            }
        };
    }

    // no-my-bubble
    // Bubble Bible s8. With no active saved bubble the aim is 0.0 deg
    // EXPLICITLY, not the engine's placeholder 1.4 deg right — which used to
    // be applied to everyone, left-handers included. Number(null) is 0 and
    // passes a bare finite check, so this is the case that catches a
    // fabricated aim reappearing.
    function case2() {
        return {
            "name" => "no-my-bubble",
            "bag" => [
                ["Driver", "205", "228"],
                ["5i", "155", "167"],
                ["7i", "138", "148"],
                ["PW", "103", "108"]
            ],
            "ghostBag" => false,
            "offsetDeg" => "0",
            "handedness" => "right",
            "green" => ["-36.9169", "174.7393"],
            "route" => [
                ["-36.9134", "174.7411"],
                ["-36.9157", "174.7398"],
                ["-36.9169", "174.7393"]
            ],
            "player" => ["-36.9157", "174.7398"],
            "target" => ["-36.9169", "174.7393"],
            "expect" => {
                "defaultTarget" => ["-36.9169", "174.7393"],
                "targetDistanceM" => "140.643",
                "shotBearingDeg" => "198.42",
                "club" => "7i",
                "carryM" => "138",
                "totalM" => "148",
                "aimOffsetDeg" => "0",
                "visualWidthM" => "21.4",
                "visualDepthM" => "28.8",
                "visualTiltDeg" => "5.53",
                "bubbleCentre" => ["-36.9169", "174.7393"],
                "ringResolution" => 168,
                "ringSample" => [
                    ["-36.9169863", "174.7392422"],
                    ["-36.9169171", "174.7391564"],
                    ["-36.9168378", "174.7391545"],
                    ["-36.9167948", "174.739238"],
                    ["-36.9168135", "174.7393579"],
                    ["-36.9168829", "174.7394438"],
                    ["-36.9169622", "174.7394455"],
                    ["-36.917005", "174.7393619"]
            ]
            }
        };
    }

    // left-handed
    // The tilt mirrors with handedness — right is positive, left is the equal
    // negative. A left-handed bubble legitimately looks like a right-handed
    // one reflected, which is also exactly what an accidental mirror in a
    // render chain looks like, so the sign is pinned here rather than judged
    // by eye. Same inputs as 'mid-iron approach' but for the handedness.
    function case3() {
        return {
            "name" => "left-handed",
            "bag" => [
                ["Driver", "205", "228"],
                ["3W", "190", "209"],
                ["5i", "155", "167"],
                ["7i", "138", "148"],
                ["9i", "118", "127"],
                ["PW", "103", "108"]
            ],
            "ghostBag" => false,
            "offsetDeg" => "3.2",
            "handedness" => "left",
            "green" => ["-36.9169", "174.7393"],
            "route" => [
                ["-36.9134", "174.7411"],
                ["-36.9145", "174.7403"],
                ["-36.9157", "174.7398"],
                ["-36.9169", "174.7393"]
            ],
            "player" => ["-36.9157", "174.7398"],
            "target" => ["-36.9169", "174.7393"],
            "expect" => {
                "defaultTarget" => ["-36.9169", "174.7393"],
                "targetDistanceM" => "140.643",
                "shotBearingDeg" => "198.42",
                "club" => "7i",
                "carryM" => "138",
                "totalM" => "148",
                "aimOffsetDeg" => "3.2",
                "visualWidthM" => "22",
                "visualDepthM" => "28.8",
                "visualTiltDeg" => "-3.99",
                "bubbleCentre" => ["-36.9168751", "174.7392173"],
                "ringResolution" => 168,
                "ringSample" => [
                    ["-36.9169701", "174.7391747"],
                    ["-36.9169124", "174.7390765"],
                    ["-36.916833", "174.739061"],
                    ["-36.9167783", "174.7391369"],
                    ["-36.9167803", "174.7392599"],
                    ["-36.9168379", "174.7393579"],
                    ["-36.9169172", "174.7393736"],
                    ["-36.916972", "174.7392978"]
            ]
            }
        };
    }

    // beyond-bag-reach
    // A target far beyond anything in the bag. Pins what the engine ACTUALLY
    // does: it selects the longest club and leaves the bubble on the target.
    // It does NOT pull the centre back to the edge of the bag -
    // gdClampBubbleCenterToBagRoof is defined in gd-app-core.js, copied into
    // the client by the generator, and called by nothing.
    // dev/fresh-app-boot.test.js pins its absence from the other direction
    // ("bag reach must not shift the completed Driver bubble centre"). The
    // Watch engine must not port it: a wrist that clamped here would disagree
    // with the phone on every out-of-range aim.
    function case4() {
        return {
            "name" => "beyond-bag-reach",
            "bag" => [
                ["9i", "118", "127"],
                ["PW", "103", "108"]
            ],
            "ghostBag" => false,
            "offsetDeg" => "3.2",
            "handedness" => "right",
            "green" => ["-36.9169", "174.7393"],
            "route" => [
                ["-36.9134", "174.7411"],
                ["-36.9157", "174.7398"],
                ["-36.9169", "174.7393"]
            ],
            "player" => ["-36.9134", "174.7411"],
            "target" => ["-36.9169", "174.7393"],
            "expect" => {
                "defaultTarget" => ["-36.9144098", "174.7405293"],
                "targetDistanceM" => "420.799",
                "shotBearingDeg" => "202.35",
                "club" => "9i",
                "carryM" => "118",
                "totalM" => "127",
                "aimOffsetDeg" => "3.2",
                "visualWidthM" => "18.9",
                "visualDepthM" => "24.6",
                "visualTiltDeg" => "6.71",
                "bubbleCentre" => ["-36.9168052", "174.7390637"],
                "ringResolution" => 168,
                "ringSample" => [
                    ["-36.9168764", "174.7390012"],
                    ["-36.9168111", "174.7389369"],
                    ["-36.9167423", "174.7389468"],
                    ["-36.9167103", "174.7390252"],
                    ["-36.9167339", "174.7391262"],
                    ["-36.9167993", "174.7391906"],
                    ["-36.9168681", "174.7391806"],
                    ["-36.9169", "174.7391021"]
            ]
            }
        };
    }

    // driver-off-the-tee
    // The longest club and the widest pattern ratios. The target sits at 228m
    // — the Driver TOTAL, not its 205m carry — because club selection ranks on
    // total. A selector that ranked on carry would pick the 3W here and pass
    // every shorter case.
    function case5() {
        return {
            "name" => "driver-off-the-tee",
            "bag" => [
                ["Driver", "205", "228"],
                ["3W", "190", "209"],
                ["5i", "155", "167"],
                ["7i", "138", "148"],
                ["PW", "103", "108"]
            ],
            "ghostBag" => false,
            "offsetDeg" => "2.1",
            "handedness" => "right",
            "green" => ["-36.9169", "174.7393"],
            "route" => [
                ["-36.9134", "174.7411"],
                ["-36.9145", "174.7403"],
                ["-36.9157", "174.7398"],
                ["-36.9169", "174.7393"]
            ],
            "player" => ["-36.9134", "174.7411"],
            "target" => ["-36.915296", "174.740125"],
            "expect" => {
                "defaultTarget" => ["-36.9152429", "174.7399905"],
                "targetDistanceM" => "227.95",
                "shotBearingDeg" => "202.35",
                "club" => "Driver",
                "carryM" => "205",
                "totalM" => "228",
                "aimOffsetDeg" => "2.1",
                "visualWidthM" => "41.6",
                "visualDepthM" => "56.4",
                "visualTiltDeg" => "7.31",
                "bubbleCentre" => ["-36.9152644", "174.7400397"],
                "ringResolution" => 168,
                "ringSample" => [
                    ["-36.9154197", "174.7399024"],
                    ["-36.9152708", "174.7397546"],
                    ["-36.915118", "174.7397736"],
                    ["-36.9150507", "174.7399487"],
                    ["-36.9151086", "174.7401774"],
                    ["-36.9152579", "174.7403254"],
                    ["-36.9154107", "174.7403059"],
                    ["-36.9154777", "174.7401306"]
            ]
            }
        };
    }

    // wedge-short-shot
    // The other end of the bag. Wedges have their own pattern ratios and the
    // smallest tilt influence, so a group lookup that quietly fell through to
    // the iron defaults would pass every longer case and fail here.
    function case6() {
        return {
            "name" => "wedge-short-shot",
            "bag" => [
                ["Driver", "205", "228"],
                ["7i", "138", "148"],
                ["PW", "103", "108"],
                ["SW", "78", "82"]
            ],
            "ghostBag" => false,
            "offsetDeg" => "1.6",
            "handedness" => "right",
            "green" => ["-36.9169", "174.7393"],
            "route" => [
                ["-36.9134", "174.7411"],
                ["-36.9169", "174.7393"]
            ],
            "player" => ["-36.9162", "174.7396"],
            "target" => ["-36.9169", "174.7393"],
            "expect" => {
                "defaultTarget" => ["-36.9169", "174.7393"],
                "targetDistanceM" => "82.279",
                "shotBearingDeg" => "198.91",
                "club" => "SW",
                "carryM" => "78",
                "totalM" => "82",
                "aimOffsetDeg" => "1.6",
                "visualWidthM" => "10",
                "visualDepthM" => "13.4",
                "visualTiltDeg" => "4.62",
                "bubbleCentre" => ["-36.9168924", "174.739276"],
                "ringResolution" => 168,
                "ringSample" => [
                    ["-36.9169326", "174.7392488"],
                    ["-36.9169006", "174.7392088"],
                    ["-36.9168637", "174.7392081"],
                    ["-36.9168436", "174.7392472"],
                    ["-36.916852", "174.7393032"],
                    ["-36.9168841", "174.7393433"],
                    ["-36.916921", "174.7393439"],
                    ["-36.9169411", "174.7393047"]
            ]
            }
        };
    }

    // green-reachable-default-target
    // The default-target rule with the green inside the bag: the target IS the
    // green, not a lay-up short of it. Spec section 8 — the wrist recomputes
    // this on hole change and on Reset.
    function case7() {
        return {
            "name" => "green-reachable-default-target",
            "bag" => [
                ["Driver", "205", "228"],
                ["5i", "155", "167"],
                ["7i", "138", "148"]
            ],
            "ghostBag" => false,
            "offsetDeg" => "3.2",
            "handedness" => "right",
            "green" => ["-36.9169", "174.7393"],
            "route" => [
                ["-36.9134", "174.7411"],
                ["-36.9157", "174.7398"],
                ["-36.9169", "174.7393"]
            ],
            "player" => ["-36.9157", "174.7398"],
            "target" => null,
            "expect" => {
                "defaultTarget" => ["-36.9169", "174.7393"],
                "targetDistanceM" => "140.643",
                "shotBearingDeg" => "198.42",
                "club" => "7i",
                "carryM" => "138",
                "totalM" => "148",
                "aimOffsetDeg" => "3.2",
                "visualWidthM" => "22",
                "visualDepthM" => "28.8",
                "visualTiltDeg" => "6.71",
                "bubbleCentre" => ["-36.9168751", "174.7392173"],
                "ringResolution" => 168,
                "ringSample" => [
                    ["-36.9169619", "174.7391535"],
                    ["-36.9168908", "174.7390705"],
                    ["-36.9168105", "174.7390735"],
                    ["-36.9167679", "174.7391607"],
                    ["-36.9167882", "174.7392812"],
                    ["-36.9168594", "174.7393642"],
                    ["-36.9169397", "174.7393611"],
                    ["-36.9169821", "174.7392738"]
            ]
            }
        };
    }

    // green-out-of-reach-lays-up
    // The same rule with the green out of range: the default target walks down
    // the hole's own route to the edge of the bag rather than cutting the
    // straight line to the green. Pinned because the fairway-line gate has
    // been supplied under the wrong name once already, and when it silently
    // never opened every out-of-reach hole laid up across the dogleg.
    function case8() {
        return {
            "name" => "green-out-of-reach-lays-up",
            "bag" => [
                ["9i", "118", "127"],
                ["PW", "103", "108"]
            ],
            "ghostBag" => false,
            "offsetDeg" => "3.2",
            "handedness" => "right",
            "green" => ["-36.9169", "174.7393"],
            "route" => [
                ["-36.9134", "174.7411"],
                ["-36.9145", "174.7403"],
                ["-36.9157", "174.7398"],
                ["-36.9169", "174.7393"]
            ],
            "player" => ["-36.9134", "174.7411"],
            "target" => null,
            "expect" => {
                "defaultTarget" => ["-36.9143952", "174.7403762"],
                "targetDistanceM" => "128.015",
                "shotBearingDeg" => "210.18",
                "club" => "9i",
                "carryM" => "118",
                "totalM" => "127",
                "aimOffsetDeg" => "3.2",
                "visualWidthM" => "18.9",
                "visualDepthM" => "24.6",
                "visualTiltDeg" => "6.71",
                "bubbleCentre" => ["-36.9143591", "174.7403096"],
                "ringResolution" => 168,
                "ringSample" => [
                    ["-36.9144218", "174.7402342"],
                    ["-36.9143494", "174.7401832"],
                    ["-36.9142827", "174.7402061"],
                    ["-36.9142606", "174.7402897"],
                    ["-36.9142963", "174.7403851"],
                    ["-36.9143688", "174.7404362"],
                    ["-36.9144356", "174.7404131"],
                    ["-36.9144575", "174.7403294"]
            ]
            }
        };
    }

    // club-boundary-just-long
    // A target just past the midpoint of two adjacent clubs (5i total 167m, 6i
    // total 157m). Together with its neighbour this pins the exact boundary
    // AND proves the engine has no hysteresis: it is a pure function of its
    // inputs and answers whichever club is nearest. The transition band is a
    // Watch INTERACTION concern and lives in WatchPlayState - if it ever leaks
    // into the engine, this pair stops being reproducible and that is the
    // signal.
    function case9() {
        return {
            "name" => "club-boundary-just-long",
            "bag" => [
                ["5i", "155", "167"],
                ["6i", "146", "157"],
                ["7i", "138", "148"]
            ],
            "ghostBag" => false,
            "offsetDeg" => "3.2",
            "handedness" => "right",
            "green" => ["-36.9169", "174.7393"],
            "route" => [
                ["-36.9134", "174.7411"],
                ["-36.9169", "174.7393"]
            ],
            "player" => ["-36.915544", "174.739997"],
            "target" => ["-36.9169", "174.7393"],
            "expect" => {
                "defaultTarget" => ["-36.9169", "174.7393"],
                "targetDistanceM" => "163.017",
                "shotBearingDeg" => "202.34",
                "club" => "5i",
                "carryM" => "155",
                "totalM" => "167",
                "aimOffsetDeg" => "3.2",
                "visualWidthM" => "24.7",
                "visualDepthM" => "32.3",
                "visualTiltDeg" => "6.71",
                "bubbleCentre" => ["-36.916865", "174.7392074"],
                "ringResolution" => 168,
                "ringSample" => [
                    ["-36.916958", "174.7391259"],
                    ["-36.9168723", "174.7390409"],
                    ["-36.9167823", "174.7390534"],
                    ["-36.9167407", "174.7391561"],
                    ["-36.916772", "174.739289"],
                    ["-36.9168578", "174.7393741"],
                    ["-36.9169478", "174.7393614"],
                    ["-36.9169893", "174.7392586"]
            ]
            }
        };
    }

    // club-boundary-just-short
    // The other side of the same boundary, four metres away, and it must
    // answer the next club down. One case cannot tell a working selector from
    // one stuck on the longest club in the bag.
    function case10() {
        return {
            "name" => "club-boundary-just-short",
            "bag" => [
                ["5i", "155", "167"],
                ["6i", "146", "157"],
                ["7i", "138", "148"]
            ],
            "ghostBag" => false,
            "offsetDeg" => "3.2",
            "handedness" => "right",
            "green" => ["-36.9169", "174.7393"],
            "route" => [
                ["-36.9134", "174.7411"],
                ["-36.9169", "174.7393"]
            ],
            "player" => ["-36.915578", "174.73998"],
            "target" => ["-36.9169", "174.7393"],
            "expect" => {
                "defaultTarget" => ["-36.9169", "174.7393"],
                "targetDistanceM" => "158.945",
                "shotBearingDeg" => "202.35",
                "club" => "6i",
                "carryM" => "146",
                "totalM" => "157",
                "aimOffsetDeg" => "3.2",
                "visualWidthM" => "23.3",
                "visualDepthM" => "30.5",
                "visualTiltDeg" => "6.71",
                "bubbleCentre" => ["-36.9168658", "174.7392097"],
                "ringResolution" => 168,
                "ringSample" => [
                    ["-36.9169534", "174.7391328"],
                    ["-36.9168725", "174.7390525"],
                    ["-36.9167876", "174.7390643"],
                    ["-36.9167484", "174.7391613"],
                    ["-36.916778", "174.7392867"],
                    ["-36.9168591", "174.739367"],
                    ["-36.916944", "174.7393551"],
                    ["-36.9169831", "174.739258"]
            ]
            }
        };
    }
}
