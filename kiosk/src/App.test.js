import { render, screen } from "@testing-library/react";
import App from "./App";

beforeEach(() => {
  global.fetch = jest.fn(() =>
    Promise.resolve({
      ok: true,
      json: () =>
        Promise.resolve([
          { id: 1, name: "Maria" },
          { id: 2, name: "Pedro" },
        ]),
    }),
  );
});

afterEach(() => {
  jest.resetAllMocks();
});

test("renders employees loaded from the API", async () => {
  render(<App />);

  expect(await screen.findByText("Maria")).toBeInTheDocument();
  expect(await screen.findByText("Pedro")).toBeInTheDocument();
});
