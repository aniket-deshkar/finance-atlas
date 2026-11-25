"use client";

import { ChakraProvider, createSystem, defaultConfig } from "@chakra-ui/react";
import type { ReactNode } from "react";

const system = createSystem(defaultConfig, {preflight: false, globalCss: {}});

export function UiProvider({children}: {children: ReactNode}) {
  return <ChakraProvider value={system}>{children}</ChakraProvider>;
}
