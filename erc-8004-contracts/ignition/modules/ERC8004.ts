import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

const ERC8004Module = buildModule("ERC8004Module", (m) => {
  // 1. Deploy IdentityRegistry
  const idImpl = m.contract("IdentityRegistryUpgradeable");
  const idInitData = m.encodeFunctionCall(idImpl, "initialize", []);
  const identityRegistry = m.contract("ERC1967Proxy", [idImpl, idInitData], { id: "IdentityProxy" });

  // 2. Deploy ReputationRegistry
  const repImpl = m.contract("ReputationRegistryUpgradeable");
  const repInitData = m.encodeFunctionCall(repImpl, "initialize", [identityRegistry]);
  const reputationRegistry = m.contract("ERC1967Proxy", [repImpl, repInitData], { id: "ReputationProxy" });

  // 3. Deploy ValidationRegistry
  const valImpl = m.contract("ValidationRegistryUpgradeable");
  const valInitData = m.encodeFunctionCall(valImpl, "initialize", [identityRegistry]);
  const validationRegistry = m.contract("ERC1967Proxy", [valImpl, valInitData], { id: "ValidationProxy" });

  return {
    identityRegistry,
    reputationRegistry,
    validationRegistry
  };
});

export default ERC8004Module;
