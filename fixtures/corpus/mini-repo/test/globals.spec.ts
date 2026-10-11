import { add } from "../src/math";
import * as s from "../src/strings";
test("namespace members count", () => expect(s.upper("a") + s.lower("B") + add(1, 1)).toBe("Ab2"));
